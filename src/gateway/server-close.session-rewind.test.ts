import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type {
  SessionsForkResult,
  SessionsRewindResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "../config/sessions/transcript-header.js";
import * as lifecycleAdmission from "../sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as agentExecution from "../state/openclaw-agent-execution.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

type CloseFixture = Awaited<ReturnType<typeof createGatewayMetadataCloseFixture>>;
const scope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:accepted-close-rewind",
  sessionId: "rewind-close-source",
};
let fixture: CloseFixture | undefined;
let prepared:
  | {
      server: Awaited<ReturnType<CloseFixture["start"]>>;
      kernel: NonNullable<ReturnType<CloseFixture["kernels"]["get"]>>;
      database: ReturnType<typeof openOpenClawAgentDatabase>;
    }
  | undefined;

beforeAll(async () => {
  fixture = await createGatewayMetadataCloseFixture("gateway-session-rewind-close");
  const port = await fixture.reservePort();
  const server = await fixture.start(port);
  const kernel = fixture.kernels.get(port);
  assert(kernel, "Gateway kernel");
  replaceSessionEntrySync(scope, {
    sessionId: scope.sessionId,
    lifecycleRevision: "rewind-close-generation",
    updatedAt: 1,
  });
  const messages = [
    { id: "user-1", parentId: null, role: "user", content: "Retain this question." },
    { id: "assistant-1", parentId: "user-1", role: "assistant", content: "Retained answer." },
    { id: "user-2", parentId: "assistant-1", role: "user", content: "Edit this question." },
  ];
  assert(
    replaceTranscriptEventsSync(scope, [
      createSessionTranscriptHeader({
        sessionId: scope.sessionId,
        cwd: fixture.state.workspaceDir,
      }),
      ...messages.map((message) => ({
        type: "message",
        id: message.id,
        parentId: message.parentId,
        message: { role: message.role, content: message.content },
      })),
    ]),
  );
  await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
  prepared = {
    server,
    kernel,
    database: openOpenClawAgentDatabase({ agentId: scope.agentId }),
  };
});

afterAll(async () => {
  // Also own teardown when startup or seeding prevents the test from running.
  await fixture?.cleanup();
});

it("persists an accepted fork and queued rewind across the close prelude before retiring their database", async ({
  signal,
}) => {
  assert(prepared && fixture, "Seeded Gateway close fixture");
  const { server, kernel, database } = prepared;
  const accepted = createDeferred();
  const releasePersistence = createDeferred();
  const preludeEntered = createDeferred();
  const rewindQueued = createDeferred();
  let forking: Promise<SessionsForkResult> | undefined;
  let rewinding: Promise<SessionsRewindResult> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const capture = agentExecution.captureOpenClawAgentDatabaseExecution;
    let executions = 0;
    vi.spyOn(agentExecution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
      (...args): ReturnType<typeof capture> => {
        const owner = capture(...args);
        return {
          ...owner,
          get fileIdentity() {
            return owner.fileIdentity;
          },
          runExisting: (source, operation, options) =>
            owner.runExisting(
              source,
              (worker) =>
                operation({
                  execute: async (command, commandOptions) => {
                    if (
                      command.type === "session.messageCut.commit" ||
                      command.type === "database.domain.publish"
                    ) {
                      executions++;
                      accepted.resolve();
                      await releasePersistence.promise;
                    }
                    return await worker.execute(command, commandOptions);
                  },
                }),
              options,
            ),
        };
      },
    );
    const dispatchOptions = {
      client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
      context: kernel.gatewayRequestContext,
      methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
    };
    const params = { sessionKey: scope.sessionKey, entryId: "user-2" };
    forking = dispatchGatewayRequestInProcess<SessionsForkResult>(
      "sessions.fork",
      params,
      dispatchOptions,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        accepted.promise,
        forking,
        "Fork settled before its accepted persistence could be held",
      ),
      signal,
    );
    const mutate = lifecycleAdmission.runExclusiveSessionLifecycleMutation;
    vi.spyOn(lifecycleAdmission, "runExclusiveSessionLifecycleMutation").mockImplementation(
      <T>(...args: Parameters<typeof mutate<T>>): Promise<T> => {
        const [operation, options] = args;
        const pending = mutate(operation, options);
        if (operation === "rewind") {
          rewindQueued.resolve();
        }
        return pending;
      },
    );
    rewinding = dispatchGatewayRequestInProcess<SessionsRewindResult>(
      "sessions.rewind",
      params,
      dispatchOptions,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        rewindQueued.promise,
        rewinding,
        "Rewind settled before entering the lifecycle queue",
      ),
      signal,
    );
    kernel.requestEntryLifetime.signal.addEventListener("abort", () => preludeEntered.resolve(), {
      once: true,
    });
    let closed = false;
    closing = server.close({ reason: "session rewind close regression" }).then(() => {
      closed = true;
    });
    await withinTest(
      awaitGateBeforeSettlement(
        preludeEntered.promise,
        closing,
        "Gateway closed before fencing request admission",
      ),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(database.db.isOpen).toBe(true);
    await expect(
      dispatchGatewayRequestInProcess("sessions.rewind", params, dispatchOptions),
    ).rejects.toThrow("Gateway request entry is closed");

    releasePersistence.resolve();
    const [fork, result] = await withinTest(Promise.all([forking, rewinding, closing]), signal);
    expect(fork).toMatchObject({
      editorText: "Edit this question.",
      sessionKey: expect.any(String),
    });
    expect(result).toEqual({ editorText: "Edit this question." });
    expect(executions).toBe(2);
    expect(database.db.isOpen).toBe(false);
    const reopened = new DatabaseSync(database.path, { readOnly: true });
    try {
      const row = reopened
        .prepare(
          "SELECT current_session_id AS session_id, json_extract(entry_json, '$.previousSessionId') AS previous_session_id FROM session_nodes WHERE session_key = ?",
        )
        .get(scope.sessionKey);
      const child = reopened
        .prepare("SELECT current_session_id AS session_id FROM session_nodes WHERE session_key = ?")
        .get(fork.sessionKey);
      assert(typeof child?.session_id === "string");
      expect(child.session_id).not.toBe(scope.sessionId);
      expect(child.session_id).not.toBe(row?.session_id);
      expect(
        reopened
          .prepare(
            "SELECT identity.event_id FROM session_transcript_active_events active JOIN transcript_event_identities identity ON identity.session_id = active.session_id AND identity.seq = active.event_seq WHERE active.session_id = ? AND active.message_position IS NOT NULL ORDER BY active.message_position",
          )
          .all(child.session_id),
      ).toEqual([{ event_id: "user-1" }, { event_id: "assistant-1" }]);
      assert(typeof row?.session_id === "string");
      expect(row.session_id).not.toBe(scope.sessionId);
      expect(row.previous_session_id).toBe(scope.sessionId);
      expect(
        reopened
          .prepare(
            "SELECT identity.event_id FROM session_transcript_active_events active JOIN transcript_event_identities identity ON identity.session_id = active.session_id AND identity.seq = active.event_seq WHERE active.session_id = ? AND active.message_position IS NOT NULL ORDER BY active.message_position",
          )
          .all(row.session_id),
      ).toEqual([{ event_id: "user-1" }, { event_id: "assistant-1" }]);
    } finally {
      reopened.close();
    }
  } finally {
    releasePersistence.resolve();
    await Promise.allSettled([forking, rewinding, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
    fixture = undefined;
  }
});
