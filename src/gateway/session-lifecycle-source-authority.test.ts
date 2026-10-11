import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { createHarnessCompletionSourceAssertion } from "../agents/agent-harness-completion-recovery.js";
import {
  captureGatewayToolCallerAssertion,
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import type { HarnessCompletionRecovery } from "../config/sessions/restart-recovery-types.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { SessionWorkStartChangedError } from "../config/sessions/work-start-error.js";
import {
  getAgentRunContext,
  readAgentRunDelegatedAuthorityFailure,
} from "../infra/agent-run-registry.js";
import { captureAgentRunTerminalPersistence } from "../infra/agent-run-terminal-writes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindInProcessRequestMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./server-methods/session-mutation-guards.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: routing.loadSessionEntry,
}));

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "lifecycle-source" });
});
afterAll(async () => state?.cleanup());
afterEach(() => {
  routing.loadSessionEntry.mockReset();
  vi.restoreAllMocks();
});

async function recoveryFixture(name: string) {
  const sessionKey = "agent:main:main";
  const sessionId = `recovery-${name}`;
  const runId = `recovery-run-${name}`;
  const target = {
    agentId: "main",
    sessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const claim: HarnessCompletionRecovery = {
    taskId: `native-child:${name}`,
    taskRunId: `native-child:${name}`,
    taskStatus: "succeeded",
    sourceRunId: `announce:${name}`,
    requesterAgentId: "main",
    requesterSessionKey: sessionKey,
    sessionId,
    lifecycleRevision: `revision-${name}`,
  };
  const entry: SessionEntry = {
    sessionId,
    lifecycleRevision: claim.lifecycleRevision,
    lifecycleRunId: runId,
    startedAt: 1_000,
    updatedAt: 1_000,
    restartRecoveryHarnessCompletion: claim,
    restartRecoveryDeliveryRunId: runId,
  };
  await replaceSessionEntry(target, entry);
  await appendTranscriptMessage(
    { ...target, sessionId },
    {
      message: {
        role: "user",
        content: "Completed synthetic child",
        idempotencyKey: `${claim.sourceRunId}:user`,
        __openclaw: { runId: claim.sourceRunId },
        provenance: {
          kind: "inter_session",
          sourceChannel: "internal",
          sourceTool: "agent_harness_completion",
          sourceSessionKey: claim.taskRunId,
        },
      },
    },
  );
  // Routing is already prepared by the caller; this boundary owns patch and source SQL.
  routing.loadSessionEntry.mockReturnValue({
    ...target,
    canonicalKey: sessionKey,
    entry: loadSessionEntry(target),
  });
  const source = createHarnessCompletionSourceAssertion({ claim, storePath: target.storePath });
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "lifecycle-source", source);
  const admittedRunContext = await admission.admit("embedded");
  const writeContext = expectDefined(
    captureAgentRunTerminalPersistence(runId).writeContext,
    "The recovery must retain its exact delegated terminal writer",
  );
  const authority = expectDefined(
    getAgentRunContext(runId)?.delegatedAuthority,
    "The recovery must hold its admitted source authority",
  );
  const scheduler = createTestGatewayScheduler();
  const owner = createSessionLifecyclePersistenceOwner(scheduler);
  return {
    target,
    entry,
    source,
    admittedRunContext,
    authority,
    owner,
    start: () =>
      owner.persist({
        sessionKey,
        agentId: "main",
        assertCommitAllowed: writeContext.assertCurrent,
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
      await scheduler.stop();
    },
  };
}

it("settles a recovered source's start and terminal lifecycle without caller-thread SQLite", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await recoveryFixture("settled");
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

it("refuses a changed same-store recovery source before lifecycle commit with the live owner's error", async () => {
  const fixture = await recoveryFixture("changed");
  try {
    const prepareSource = expectDefined(
      fixture.source.prepareSessionSource,
      "Recovery has worker source preparation",
    );
    const replacement = { ...fixture.entry, restartRecoveryHarnessCompletion: undefined };
    fixture.source.prepareSessionSource = async () => {
      const prepared = await prepareSource();
      try {
        // The foreign writer changes the receipt after its read, before dispatch or any grant.
        replaceSessionEntrySync(fixture.target, replacement);
        return prepared;
      } catch (error) {
        await prepared.release?.();
        throw error;
      }
    };

    await expect(fixture.finish()).rejects.toMatchObject({
      name: "Error",
      message: "Terminal write owner changed before commit",
    });
    expect(readAgentRunDelegatedAuthorityFailure(fixture.authority)?.cause).toBeInstanceOf(
      SessionWorkStartChangedError,
    );
    expect(loadSessionEntry(fixture.target)).toMatchObject({
      startedAt: 1_000,
      updatedAt: 1_000,
    });
    expect(loadSessionEntry(fixture.target)?.status).toBeUndefined();
    expect(loadSessionEntry(fixture.target)?.endedAt).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

it("keeps cross-store patches native and refuses a source revoked before submission", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await recoveryFixture("cross-store");
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
        patchSessionEntryCore(target, () => ({ label: "native cross-store write" }), {
          workerGuard: { source: fixture.source },
        }),
      ).resolves.toMatchObject({ label: "native cross-store write" });
      expect(sql.executedQueries).toContainEqual(
        expect.stringMatching(/^insert into "session_nodes" /i),
      );
      // The statement execution observer distinguishes native work from worker-only writes.
      expect(sql.calls[4]).toHaveBeenCalled();
    } finally {
      sql.restore();
    }
    expect(loadSessionEntry(target)?.label).toBe("native cross-store write");
    const prepare = expectDefined(fixture.source.prepareSessionSource, "Prepared recovery source");
    fixture.source.prepareSessionSource = async () => {
      const prepared = await prepare();
      try {
        replaceSessionEntrySync(fixture.target, {
          ...fixture.entry,
          restartRecoveryHarnessCompletion: undefined,
        });
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
    expect(loadSessionEntry(target)?.label).toBe("native cross-store write");
  } finally {
    await fixture.close();
  }
});

it("keeps a recovered tool caller's source preparation through in-process Stop authority", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await recoveryFixture("in-process-stop-source");
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
    routing.loadSessionEntry.mockReturnValue({
      ...target,
      canonicalKey: target.sessionKey,
      entry: loadSessionEntry(target),
    });
    const caller = expectDefined(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: fixture.admittedRunContext,
        agentId: "main",
        sessionKey: fixture.target.sessionKey,
      }),
      "the real admitted recovery run must issue its caller identity",
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
        await fixture.owner.persist({
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
