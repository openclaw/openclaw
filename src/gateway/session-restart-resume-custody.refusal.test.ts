import { afterEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryChangesToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type * as SessionAccessor from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadSessionTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";
import { prepareRestartStores } from "./session-restart-resume-discovery.js";

// Only requester admission is replaced, so each case chooses the exact refusal class;
// custody, the subagent registry and the chat transcripts are the real owners.
// mock-isolation: real admission would need a live plugin grant owner for every refusal class.
vi.mock("./operator-run-recovery.js", () => ({
  restoreGatewayQueuedOperatorRecovery: vi.fn(),
}));
const restore = vi.mocked(restoreGatewayQueuedOperatorRecovery);
// The real transcript owner, except that one case can make the notice append fail.
const noticeAppend = vi.hoisted(() => ({ fail: false }));
vi.mock("../config/sessions/session-accessor.js", async (importActual) => {
  const actual = await importActual<typeof SessionAccessor>();
  return {
    ...actual,
    appendSessionTranscriptReport: (
      ...args: Parameters<typeof SessionAccessor.appendSessionTranscriptReport>
    ) =>
      noticeAppend.fail
        ? Promise.resolve({ ok: false, error: { code: "test-append-refused" } })
        : actual.appendSessionTranscriptReport(...args),
  };
});

const DAY_MS = 24 * 60 * 60_000;
// The fixed wording: no requester, grant, or result content.
const NOTICE =
  "A background task's result couldn't be delivered because the access it ran under has ended.";
const target = () => ({
  agentId: "main",
  physicalAgentId: "main",
  storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
});
const refusal = (cause: GatewayOperatorAccessDeniedError["accessCause"]) => {
  const denied = new GatewayOperatorAccessDeniedError(cause);
  return new GatewayOperatorRecoveryAuthorizationError(denied.message, { cause: denied });
};

const created: string[] = [];
afterEach(() => {
  for (const runId of created.splice(0)) {
    subagentRuns.delete(runId);
  }
  clearSubagentRunsReadCacheForTest();
  restore.mockReset();
  noticeAppend.fail = false;
});

function openChat(name: string) {
  const sessionKey = `agent:main:dashboard:${name}`;
  const entry = { sessionId: name, lifecycleRevision: `${name}-rev`, updatedAt: 1 };
  replaceSessionEntrySync({ ...target(), sessionKey }, entry);
  return { sessionKey, ...entry };
}

/** A finished child whose result is still owed to its requesting chat. */
function owedChild(
  chat: ReturnType<typeof openChat>,
  runId: string,
  endedAt: number,
  capturedAt?: number,
) {
  const child = createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: chat.sessionKey,
    requesterAgentId: "main",
    requesterStorePath: target().storePath,
    completionRequesterSessionId: chat.sessionId,
    completionRequesterLifecycleRevision: chat.lifecycleRevision,
    expectsCompletionMessage: true,
    spawnMode: "session",
    completionTarget: "parent",
    createdAt: endedAt - 1_000,
    endedAt,
    delivery: { status: "pending" },
    // The source value is opaque here; each child gets its own so attempts count per child.
    requesterOperatorSource: { kind: "unavailable", reason: runId } as never,
  });
  if (capturedAt !== undefined) {
    child.completion = { ...child.completion, required: true, capturedAt };
  }
  subagentRuns.set(child.runId, child);
  subagentRuns.retireCompletionAuthority(child);
  saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
  created.push(child.runId);
  return child;
}

async function restartRecovery() {
  const context = createContext();
  context.resolveGatewayContext = () => context;
  const restart = { context, signal: new AbortController().signal, log: { warn: vi.fn() } };
  const stores = await prepareRestartStores(restart, [target()]);
  await prepareRestartCompletionCustody(restart, stores![0]!);
  return restart.log.warn.mock.calls.map(([line]) => String(line));
}

async function notices(chat: ReturnType<typeof openChat>) {
  const events = await loadSessionTranscriptEvents({
    agentId: "main",
    sessionId: chat.sessionId,
    sessionKey: chat.sessionKey,
    storePath: target().storePath,
  });
  return events.filter((event) => JSON.stringify(event).includes(NOTICE));
}

function attemptsFor(child: SubagentRunRecord) {
  return restore.mock.calls.filter(
    ([params]) => JSON.stringify(params.source) === JSON.stringify(child.requesterOperatorSource),
  ).length;
}

const withState = (run: () => Promise<void>) =>
  withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      setRuntimeConfigSnapshot({});
      await run();
    },
  );

it.for(["grant-revoked", "access-record-inactive"] as const)(
  "settles refused children once with one notice to their requesting chat (%s)",
  (cause) =>
    withState(async () => {
      const requesting = openChat("requesting");
      const other = openChat("other");
      const children = [1, 2].map((n) =>
        owedChild(requesting, `refused-${n}`, Date.now() - DAY_MS),
      );
      restore.mockRejectedValue(refusal(cause));

      await restartRecovery();
      await restartRecovery();

      // Settled once: the second restart no longer re-admits them.
      for (const child of children) {
        expect(attemptsFor(child)).toBe(1);
        const settled = subagentRuns.get(child.runId);
        expect(settled?.delivery?.status).toBe("discarded");
        expect(settled?.suppressCompletionDelivery).toBe(true);
        // The undelivered result stays in the run record.
        expect(settled?.completion).toEqual(child.completion);
      }
      const shown = await notices(requesting);
      expect(shown).toHaveLength(1);
      expect(await notices(other)).toEqual([]);
      for (const child of children) {
        // No run, child or requester identity in the chat row, including its details.
        expect(JSON.stringify(shown[0])).not.toContain(child.childSessionKey);
        expect(JSON.stringify(shown[0])).not.toContain(child.runId);
      }
    }),
);

it("settles a refused result older than 7 days without a chat notice", () =>
  withState(async () => {
    const chat = openChat("stale");
    const stale = owedChild(chat, "stale-child", Date.now() - 30 * DAY_MS);
    const fresh = owedChild(openChat("fresh"), "fresh-child", Date.now() - DAY_MS);
    restore.mockRejectedValue(refusal("grant-revoked"));

    const warnings = await restartRecovery();

    expect(subagentRuns.get(stale.runId)?.delivery?.status).toBe("discarded");
    expect(subagentRuns.get(fresh.runId)?.delivery?.status).toBe("discarded");
    expect(await notices(chat)).toEqual([]);
    expect(
      await notices({ ...chat, sessionKey: fresh.requesterSessionKey, sessionId: "fresh" }),
    ).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("older than 7 days"))).toEqual([
      "Restart completion recovery settled 1 refused results older than 7 days without a chat notice; their results remain in the subagent run records.",
    ]);
  }));

it("keeps a refused child pending when its notice cannot be written, without failing the chat", () =>
  withState(async () => {
    const chat = openChat("notice-failure");
    const child = owedChild(chat, "notice-failure-child", Date.now() - DAY_MS);
    restore.mockRejectedValue(refusal("grant-revoked"));
    noticeAppend.fail = true;

    const warnings = await restartRecovery();

    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("pending");
    expect(warnings).toContainEqual(
      expect.stringContaining("Restart completion refusal settlement failed in"),
    );
    // Settlement errors stay inside the chat's recovery, so recovered siblings keep custody.
    expect(warnings).not.toContainEqual(
      expect.stringContaining(`Restart completion recovery failed for ${chat.sessionKey}:`),
    );

    noticeAppend.fail = false;
    await restartRecovery();
    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("discarded");
    expect(await notices(chat)).toHaveLength(1);
  }));

it("notifies for an old row whose result was captured recently", () =>
  withState(async () => {
    const chat = openChat("recaptured");
    // Created and ended a month ago, but its result was captured yesterday.
    const child = owedChild(
      chat,
      "recaptured-child",
      Date.now() - 30 * DAY_MS,
      Date.now() - DAY_MS,
    );
    restore.mockRejectedValue(refusal("grant-revoked"));

    const warnings = await restartRecovery();

    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("discarded");
    expect(await notices(chat)).toHaveLength(1);
    expect(warnings.some((line) => line.includes("older than 7 days"))).toBe(false);
  }));

it.for([
  ["thrown policy error", () => refusal("policy-check-failed")],
  // A refusal without an ended-grant or deleted-profile cause, such as admission's refuse().
  ["refusal without an ended-access cause", () => new GatewayOperatorRecoveryAuthorizationError()],
  ["unavailable owner", () => new GatewayOperatorAccessUnavailableError()],
  ["database error", () => new Error("database is locked")],
] as const)("keeps a child pending after a %s", ([, failure]) =>
  withState(async () => {
    const chat = openChat("transient");
    const child = owedChild(chat, "transient-child", Date.now() - DAY_MS);
    restore.mockRejectedValue(failure());

    await restartRecovery();
    await restartRecovery();

    expect(attemptsFor(child)).toBe(2);
    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("pending");
    expect(await notices(chat)).toEqual([]);
  }),
);
