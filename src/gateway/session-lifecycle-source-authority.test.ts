import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  captureGatewayToolCallerAssertion,
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { SessionWorkStartChangedError } from "../config/sessions/work-start-error.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { captureAgentRunTerminalPersistence } from "../infra/agent-run-terminal-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createAgentEventTestHarness,
  type AgentEventTestHarnessOptions,
} from "./server-chat.agent-events.test-harness.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindInProcessRequestMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./server-methods/session-mutation-guards.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "lifecycle-source" });
});
afterAll(async () => state?.cleanup());
beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function sourceFixture(name: string) {
  const sessionKey = "agent:main:main";
  const sessionId = `source-${name}`;
  const runId = `source-run-${name}`;
  const target = {
    agentId: "main",
    sessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry: SessionEntry = {
    sessionId,
    lifecycleRevision: `revision-${name}`,
    lifecycleRunId: runId,
    startedAt: 1_000,
    updatedAt: 1_000,
  };
  await replaceSessionEntry(target, entry);
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new SessionWorkStartChangedError(sessionKey);
    }
  };
  const source = captureSessionEntrySourceAssertion({
    scope: target,
    expected: entry,
    fields: ["sessionId", "lifecycleRevision"],
    assertCurrent,
    assertHostCurrent: assertCurrent,
    refuse() {
      throw new SessionWorkStartChangedError(sessionKey);
    },
  });
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "lifecycle-source", source);
  const admittedRunContext = await admission.admit("embedded");
  const writeContext = expectDefined(
    captureAgentRunTerminalPersistence(runId).writeContext,
    "The run must retain its exact delegated terminal writer",
  );
  const authority = expectDefined(
    getAgentRunContext(runId)?.delegatedAuthority,
    "The run must hold its admitted source authority",
  );
  const owner = createSessionLifecyclePersistenceOwner();
  return {
    target,
    entry,
    runId,
    writeContext,
    source,
    revokeSource: () => {
      current = false;
    },
    admittedRunContext,
    authority,
    owner,
    start: () =>
      owner.persist({
        sessionKey,
        agentId: "main",
        assertCommitAllowed: source,
        event: {
          runId,
          sessionId,
          lifecycleGeneration: authority.lifecycleGeneration,
          ts: 2_000,
          data: { phase: "start", startedAt: 2_000 },
        },
      }),
    finish: () =>
      owner.observe({
        sessionKey,
        agentId: "main",
        writeContext,
        event: {
          runId,
          sessionId,
          lifecycleGeneration: authority.lifecycleGeneration,
          seq: 2,
          stream: "lifecycle",
          ts: 3_000,
          data: { phase: "end", startedAt: 2_000, endedAt: 3_000 },
        },
      }),
    async close() {
      await owner.drain();
      admission.close();
    },
  };
}

it("settles an admitted source's start and terminal lifecycle without caller-thread SQLite", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await sourceFixture("settled");
  try {
    const sql = observeHostDataSql();
    try {
      await fixture.start();
      await fixture.finish();
      for (const call of sql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      sql.restore();
    }
    expect(loadSessionEntry(fixture.target)).toMatchObject({
      status: "done",
      startedAt: 2_000,
      endedAt: 3_000,
      runtimeMs: 1_000,
    });
  } finally {
    await fixture.close();
  }
});

it("reuses the eager write through chat while persisting the remapped terminal run", async () => {
  const fixture = await sourceFixture("chat-handoff");
  const clientRunId = "client-terminal-handoff";
  const track =
    vi.fn<NonNullable<AgentEventTestHarnessOptions["trackTrackedRunTerminalPersistence"]>>();
  const h = createAgentEventTestHarness({
    persistGatewaySessionLifecycleEventForEvent: fixture.owner.persist,
    trackTrackedRunTerminalPersistence: track,
  });
  try {
    await fixture.start();
    h.register(fixture.runId, fixture.target.sessionKey, clientRunId);
    const event: AgentEventRuntimePayload = {
      runId: fixture.runId,
      sessionId: fixture.entry.sessionId,
      seq: 2,
      stream: "lifecycle",
      ts: 3_000,
      data: { phase: "end", startedAt: 2_000, endedAt: 3_000 },
    };
    Object.defineProperty(event, "lifecycleGeneration", {
      value: fixture.authority.lifecycleGeneration,
      enumerable: false,
    });
    const persistence = fixture.owner.observe({
      ...fixture.target,
      event,
      clientRunId,
      writeContext: fixture.writeContext,
    });
    await h.handler(event);
    await persistence;
    expect(fixture.owner.persist({ ...fixture.target, event })).toBe(persistence);
    expect(loadSessionEntry(fixture.target)).toMatchObject({
      status: "done",
      lastRunId: clientRunId,
      startedAt: 2_000,
      endedAt: 3_000,
    });
    expect(track).toHaveBeenCalledOnce();
    expect(track.mock.calls[0]?.[0].persistence).toBe(persistence);
  } finally {
    await h.handler.dispose();
    await fixture.close();
  }
});

it("settles terminal bookkeeping after its source authority no longer admits work", async () => {
  const fixture = await sourceFixture("changed");
  try {
    // A yielded checkpoint needs a resume write; an already-running start is a no-op.
    const replacement = {
      ...fixture.entry,
      endedAt: 1_500,
    };
    replaceSessionEntrySync(fixture.target, replacement);
    fixture.revokeSource();
    await expect(fixture.start()).rejects.toBeInstanceOf(SessionWorkStartChangedError);
    await fixture.finish();
    expect(loadSessionEntry(fixture.target)).toMatchObject({
      status: "done",
      startedAt: 2_000,
      endedAt: 3_000,
    });
  } finally {
    await fixture.close();
  }
});

it("writes cross-store patches in the worker and refuses a source revoked before submission", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await sourceFixture("cross-store");
  const target = {
    agentId: "main",
    sessionKey: "agent:main:cross-store-target",
    storePath: path.join(state.sessionsDir(), "cross-store.sqlite"),
  };
  try {
    await replaceSessionEntry(target, {
      sessionId: "cross-store-target",
      updatedAt: 1_000,
      label: "unchanged",
    });
    const sql = observeHostDataSql();
    try {
      await expect(
        patchSessionEntryCore(target, () => ({ label: "worker cross-store write" }), {
          workerGuard: { source: fixture.source },
        }),
      ).resolves.toMatchObject({ label: "worker cross-store write" });
      expect(
        sql.queries.filter(
          (query) => /^(?:insert|update|delete)\b/i.test(query) && isSessionEntryDataSql(query),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(loadSessionEntry(target)?.label).toBe("worker cross-store write");
    const prepare = expectDefined(fixture.source.prepareSessionSource, "Prepared session source");
    fixture.source.prepareSessionSource = async () => {
      const prepared = await prepare();
      try {
        fixture.revokeSource();
        return prepared;
      } catch (error) {
        await prepared.release?.();
        throw error;
      }
    };
    await expect(
      patchSessionEntryCore(target, () => ({ label: "unauthorized write" }), {
        workerGuard: { source: fixture.source },
      }),
    ).rejects.toBeInstanceOf(SessionWorkStartChangedError);
    expect(loadSessionEntry(target)?.label).toBe("worker cross-store write");
  } finally {
    await fixture.close();
  }
});

it("keeps an admitted tool caller's source preparation through in-process Stop authority", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await sourceFixture("in-process-stop-source");
  const target = { ...fixture.target, sessionKey: "agent:main:stop-target" };
  const runId = "stop-target-run";
  const sessionId = "stop-target-session";
  try {
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: 1_000,
      startedAt: 1_000,
      lifecycleRunId: runId,
      activeWriterRunId: runId,
    });
    const caller = expectDefined(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: fixture.admittedRunContext,
        agentId: "main",
        sessionKey: fixture.target.sessionKey,
      }),
      "the real admitted run must issue its caller identity",
    );
    await withGatewayToolCallerIdentity(caller, async () => {
      const assertCallerCurrent = expectDefined(
        captureGatewayToolCallerAssertion("sessions.abort"),
        "captured Stop caller",
      );
      const context = createDirectChatContext();
      const client = createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "system" },
        scopes: ["operator.write"],
      });
      // Dispatch carries the actual captured caller through its composed host guard.
      const sessionMutationCommitGuard = composeSessionSourceAssertion([assertCallerCurrent]);
      const req = {
        type: "req" as const,
        id: "recovered-tool-stop",
        method: "sessions.abort",
        params: { key: target.sessionKey, runId },
      };
      const request = bindInProcessRequestMutationAuthority(
        {
          req,
          client,
          context,
          respond: vi.fn(),
          isWebchatConnect: () => false,
          sessionMutationCommitGuard,
        },
        undefined,
        sessionMutationCommitGuard,
      );
      const handler = bindGatewayRequestHandlerMutationAuthority(
        request,
        {
          ...request,
          params: req.params,
        },
        undefined,
      );
      const authority = readGatewayRequestMutationAuthority(handler);
      // sessions.abort passes this request authority into the same lifecycle writer.
      const assertAbortCurrent = composeSessionSourceAssertion([authority.assertCurrent]);
      const sql = observeHostDataSql();
      try {
        await persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          agentId: "main",
          assertCommitAllowed: assertAbortCurrent,
          event: {
            runId,
            sessionId,
            lifecycleGeneration: fixture.authority.lifecycleGeneration,
            ts: 3_000,
            data: {
              phase: "end",
              status: "cancelled",
              aborted: true,
              stopReason: "rpc",
              startedAt: 1_000,
              endedAt: 3_000,
            },
          },
        });
        for (const call of sql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        sql.restore();
      }
    });
    expect(loadSessionEntry(target)).toMatchObject({ status: "killed", endedAt: 3_000 });
  } finally {
    await fixture.close();
  }
});
