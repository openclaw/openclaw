// karmaterminal/openclaw#1271: a continue_work wake kept across a same-owner /new or reset stays
// bound to the recipient authority its session had when the work was elected. A real handover
// (owner change, visibility narrowing, member removal, delete) refuses it at the wake, and at the
// replay after a restart, before any turn runs. Real: the agent database and its authority epochs,
// the election, the Gateway reset, the dispatcher, the custody boot. Observed only: the turns the
// reply owner is asked to run and the log lines.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as accessor from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { deleteGatewaySession } from "../../gateway/server-methods/sessions-delete.js";
import { performGatewaySessionReset } from "../../gateway/session-reset-service.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { runContinuationCustodyBoot } from "./custody-boot.js";
import { resetContinuationCustodyProjection } from "./custody/custody-projection.js";
import { hydrateContinuationCustody, listContinuationRecords } from "./custody/custody-store.js";
import {
  dispatchPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
} from "./work-dispatch.js";
import { decodeWorkState } from "./work-flow-state.js";
import { enqueuePendingWork } from "./work-store.test-support.js";

const replyTurns = vi.hoisted(() => [] as string[]);
// The reply owner is the boundary where "a wake turn ran" is observable.
vi.mock("../reply/get-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reply/get-reply.js")>()),
  getReplyFromConfig: async (ctx: { Body?: string }) => {
    replyTurns.push(ctx.Body ?? "");
    return { text: "continued" };
  },
}));
const logLines = vi.hoisted(() => [] as string[]);
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return {
        ...logger,
        warn: (message: string, meta?: Record<string, unknown>) => {
          logLines.push(message);
          logger.warn(message, meta);
        },
      };
    },
  };
});

const KEY = "agent:main:work-authority";
const cfg = { agents: { defaults: { continuation: { enabled: true } }, entries: { main: {} } } };
const ownerA = { type: "human" as const, source: "unknown" as const, id: "owner-a" };
const ownerB = { type: "human" as const, id: "owner-b" };
type Scope = { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };

const handovers: Record<string, (scope: Scope) => Promise<unknown>> = {
  "owner change": async (scope) =>
    accessor.assignSessionOwner(scope, { owner: ownerB, assignedBy: ownerA, assignedAt: 3 }),
  "visibility narrowing": (scope) =>
    accessor.patchSessionEntryCore(scope, () => ({ visibility: "draft" })),
  "member removal": (scope) => removeSessionMember(scope, "member-a"),
  // A deletion owner that leaves custody to the binding (the Gateway delete also cancels it).
  "delete and recreate": async (scope) => {
    await accessor.deleteSessionEntryLifecycle({
      agentId: scope.agentId,
      archiveTranscript: false,
      storePath: resolveOpenClawAgentSqlitePath(scope),
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });
    await accessor.upsertSessionEntryCore(scope, { sessionId: "recreated", updatedAt: 4 });
  },
};

beforeEach(() => {
  // Dispatch timers (the reset's re-arm among them) fire only when a test drives dispatch.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterEach(() => {
  resetContinuationWorkDispatchForTests();
  resetContinuationCustodyProjection();
  resetPluginRuntimeStateForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  replyTurns.length = 0;
  logLines.length = 0;
});

/**
 * A shared session owned by owner A with one member. Its authority row exists before any election,
 * as for a session that ever bound a delegate or return, unless `captured` is false.
 */
async function withSession(
  run: (scope: Scope) => Promise<void>,
  { captured = true }: { captured?: boolean } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
    setRuntimeConfigSnapshot(cfg);
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    await hydrateContinuationCustody();
    const scope = { agentId: "main", env: state.env, sessionKey: KEY };
    await accessor.upsertSessionEntryCore(scope, {
      sessionId: "head-1",
      updatedAt: 1,
      createdActor: ownerA,
      visibility: "shared",
    });
    await addSessionMember(scope, { identityId: "member-a", addedBy: ownerA.id, addedAt: 2 });
    if (captured) {
      await accessor.captureSessionRecipientAuthority(scope);
    }
    // Worker threads stamp authority rows on the real clock; elections follow every setup write.
    vi.setSystemTime(vi.getRealSystemTime() + 1);
    await run(scope);
  });
}

/** The production election: one continue_work due in 60 s. */
async function elect(): Promise<{ recordId: string; dueAt: number }> {
  const result = await scheduleContinuationWork({
    sessionKey: KEY,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    request: { reason: "finish the audit", delaySeconds: 60 },
    config: resolveContinuationRuntimeConfig(),
  });
  expect(result.scheduled).toBe(true);
  return liveWork();
}

/** A record a build before the binding elected: the same state shape, no binding. */
async function electUnbound(): Promise<{ recordId: string; dueAt: number }> {
  const now = Date.now();
  await enqueuePendingWork(
    {
      sessionKey: KEY,
      hop: 1,
      delayMs: 60_000,
      electedAt: now,
      dueAt: now + 60_000,
      anchorFinalizedAt: now,
      maxChainLength: 8,
      reason: "finish the audit",
    },
    { bind: false },
  );
  return liveWork();
}

/** The newest live election. */
async function liveWork() {
  const record = (
    await listContinuationRecords({ ownerSessionKey: KEY, kinds: ["work"], statuses: ["queued"] })
  ).at(-1);
  if (!record?.dueAt) {
    throw new Error("expected one queued continue_work record");
  }
  return { recordId: record.recordId, dueAt: record.dueAt };
}

const readWork = async (recordId: string) =>
  (await listContinuationRecords({ recordIds: [recordId] }))[0];

/** A same-owner Gateway reset; returns the successor head's lifecycle revision. */
async function resetSession(reason: "new" | "reset") {
  const reset = await performGatewaySessionReset({
    key: KEY,
    agentId: "main",
    reason,
    commandSource: "test",
    operatorRoleActor: { kind: "system" },
    workerPlacementContext: {},
  });
  if (!reset.ok || !("entry" in reset)) {
    throw new Error("expected a committed same-owner reset");
  }
  return reset.entry.lifecycleRevision;
}

/** A restart: process-local dispatch state is gone; the custody boot replays durable state. */
async function restartAndBoot() {
  resetContinuationWorkDispatchForTests();
  await runContinuationCustodyBoot({
    armedAt: Date.now(),
    whenSubagentRegistryActivated: async () => {},
  });
}

const wakeTurns = () => replyTurns.filter((body) => body.startsWith("[continuation:wake]"));

async function expectRefused(
  recordId: string,
  stage: string,
  reason = "recipient-authority-changed",
) {
  expect(wakeTurns()).toEqual([]);
  expect(await readWork(recordId)).toMatchObject({ status: "failed", failureReason: reason });
  expect(logLines).toContain(
    `[continuation:work-refused] stage=${stage} reason=${reason} session=${KEY} flowId=${recordId}`,
  );
}

describe("a kept continue_work wake is bound to its recipient authority", () => {
  it.each(["new", "reset"] as const)(
    "same-owner %s keeps the bound wake, which wakes the successor once at its original due time",
    async (reason) => {
      await withSession(async (scope) => {
        const { recordId, dueAt } = await elect();
        const authority = await accessor.captureSessionRecipientAuthority(scope);
        expect(decodeWorkState((await readWork(recordId))!)?.recipientAuthority).toEqual(authority);

        expect(await resetSession(reason)).toEqual(expect.any(String));
        expect(await readWork(recordId)).toMatchObject({ status: "queued", dueAt });
        await dispatchPendingContinuationWork({ sessionKey: KEY });
        expect(wakeTurns()).toEqual([]);

        vi.setSystemTime(dueAt + 1);
        await dispatchPendingContinuationWork({ sessionKey: KEY });
        await dispatchPendingContinuationWork({ sessionKey: KEY });
        expect(wakeTurns()).toHaveLength(1);
        expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
      });
    },
  );

  it.each(Object.keys(handovers))(
    "%s after a same-owner reset refuses the bound wake at its due time",
    async (handover) => {
      await withSession(async (scope) => {
        const { recordId, dueAt } = await elect();
        await resetSession("reset");
        await handovers[handover]!(scope);

        vi.setSystemTime(dueAt + 1);
        await dispatchPendingContinuationWork({ sessionKey: KEY });
        await expectRefused(recordId, "wake");
      });
    },
  );

  it.each(Object.keys(handovers))(
    "%s while the Gateway is down refuses the bound wake at replay",
    async (handover) => {
      await withSession(async (scope) => {
        const { recordId, dueAt } = await elect();
        await resetSession("reset");
        await handovers[handover]!(scope);

        vi.setSystemTime(dueAt + 1);
        await restartAndBoot();
        await expectRefused(recordId, "replay");
      });
    },
  );

  it("the Gateway delete still cancels the wake, and a recreated session gets none", async () => {
    await withSession(async (scope) => {
      const { recordId, dueAt } = await elect();
      const context = createDirectChatContext({
        getRuntimeConfig: () => cfg,
        getCommittedRuntimeConfig: () => cfg,
      });
      await deleteGatewaySession({ params: { key: KEY, agentId: "main" }, client: null, context });
      await accessor.upsertSessionEntryCore(scope, { sessionId: "recreated", updatedAt: 4 });

      vi.setSystemTime(dueAt + 1);
      await dispatchPendingContinuationWork({ sessionKey: KEY });
      expect(wakeTurns()).toEqual([]);
      expect(await readWork(recordId)).toMatchObject({ status: "cancelled" });
    });
  });
});

describe("a kept continue_work wake elected before the binding existed", () => {
  it("survives a same-owner reset and wakes once", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await electUnbound();
      await resetSession("reset");

      vi.setSystemTime(dueAt + 1);
      await dispatchPendingContinuationWork({ sessionKey: KEY });
      await dispatchPendingContinuationWork({ sessionKey: KEY });
      expect(wakeTurns()).toHaveLength(1);
      expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
    });
  });

  it.each(
    Object.keys(handovers).flatMap((handover) => [
      [handover, "wake"],
      [handover, "replay"],
    ]),
  )("%s after its election fences it at the %s", async (handover, stage) => {
    await withSession(async (scope) => {
      const { recordId, dueAt } = await electUnbound();
      await resetSession("reset");
      await handovers[handover]!(scope);

      vi.setSystemTime(dueAt + 1);
      await (stage === "wake"
        ? dispatchPendingContinuationWork({ sessionKey: KEY })
        : restartAndBoot());
      await expectRefused(recordId, stage);
    });
  });

  // The named loss: a session whose authority row is first written after the election (here by a
  // bound election's capture) cannot prove its recipient unchanged, so the unbound wake is refused.
  it("fails closed when its session's authority was first recorded after the election", async () => {
    await withSession(
      async () => {
        const { recordId, dueAt } = await electUnbound();
        vi.setSystemTime(dueAt);
        await elect();

        vi.setSystemTime(dueAt + 1);
        await dispatchPendingContinuationWork({ sessionKey: KEY });
        await expectRefused(recordId, "wake", "recipient-authority-unverifiable");
      },
      { captured: false },
    );
  });
});
