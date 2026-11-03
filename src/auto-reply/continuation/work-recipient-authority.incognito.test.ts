// karmaterminal/openclaw#1271: a continue_work election binds the session's recipient-authority
// epoch before its record is written. An incognito session has no durable recipient authority, so
// its election fails visibly and elects nothing; a durable session's election binds its epoch.
// Real: the continue_work tool, the agent runner's post-turn seam, the chain reservation, the
// custody store, the authority capture, the next turn's system-event drain and the incognito memory
// owner, bound around each turn as the Gateway's incognito dispatch binds it. Observed only: the
// operator custody the Gateway hands an operator's tool call, through its release.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, expect, it, vi } from "vitest";
import { createContinueWorkTool } from "../../agents/tools/continue-work-tool.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as accessor from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { commitMemory } from "../../config/sessions/session-actor-memory-publication.test-support.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { scheduleReplyContinuation } from "../reply/agent-runner-continuation-schedule.js";
import { createReplyContinuationController } from "../reply/agent-runner-continuation.js";
import { createTestFollowupRun } from "../reply/agent-runner.test-fixtures.js";
import { drainFormattedSystemEvents } from "../reply/session-system-events.js";
import { resetContinuationCustodyProjection } from "./custody/custody-projection.js";
import { hydrateContinuationCustody, listContinuationRecords } from "./custody/custody-store.js";
import { extractContinuationSignal } from "./signal.js";
import type { ContinueWorkRequest } from "./types.js";
import { resetContinuationWorkDispatchForTests } from "./work-dispatch.js";
import { decodeWorkState } from "./work-flow-state.js";

const operatorReleases = vi.hoisted(() => [] as Array<() => void>);
// The Gateway hands each operator continue_work call its policy custody; only its release is observed.
vi.mock("../../gateway/server-plugin-in-process-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/server-plugin-in-process-authority.js")>()),
  captureOperatorToolGatewayContinuationContext: async () => {
    const release = vi.fn();
    operatorReleases.push(release);
    return { operatorAuthority: {}, assertCurrent() {}, run: <T>(run: () => T) => run(), release };
  },
}));

// The exact prompt line, timestamp aside.
const SCHEDULING_FAILED =
  /^System: \[[^\]]+\] \[continuation\] continue_work scheduling failed; the reserved chain budget remains fail-closed\.$/u;
const cfg = { agents: { defaults: { continuation: { enabled: true } }, entries: { main: {} } } };
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };

afterEach(() => {
  resetContinuationWorkDispatchForTests();
  resetContinuationCustodyProjection();
  resetSystemEventsForTest();
  memorySessionActorOwners.reset();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  operatorReleases.length = 0;
});

async function withState(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
    setRuntimeConfigSnapshot(cfg);
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    await hydrateContinuationCustody();
    await run(state.env);
  });
}

/** One turn whose model called continue_work once, then the runner's post-turn election. */
async function electThroughTurn(sessionKey: string, storePath: string, entry: SessionEntry) {
  const requests: ContinueWorkRequest[] = [];
  const tool = createContinueWorkTool({
    agentSessionKey: sessionKey,
    requestContinuation: (request) => {
      requests.push(request);
    },
  });
  // The model is told the call was accepted; the election itself runs after the turn.
  const toolResult = await tool.execute("call-1", { reason: "finish the audit", delaySeconds: 60 });
  expect(toolResult.details).toMatchObject({ status: "scheduled" });
  const extraction = extractContinuationSignal({
    payloads: [{ text: "Auditing." }],
    continueWorkRequest: requests[0],
    enabled: true,
    sessionKey,
  });
  let activeEntry: SessionEntry | undefined = entry;
  const continuation = createReplyContinuationController({
    cfg,
    sessionKey,
    storePath,
    isContinuationWake: false,
    activeSessionStore: undefined,
    getActiveSessionEntry: () => activeEntry,
    setActiveSessionEntry: (next) => {
      activeEntry = next;
    },
  });
  await scheduleReplyContinuation({
    cfg,
    sessionKey,
    followupRun: createTestFollowupRun({ sessionId: entry.sessionId, sessionKey }),
    runId: "run-1",
    usage: { input: 1, output: 1 },
    effectiveContinuationSignal: extraction.signal,
    continuationExtractionFromBracket: extraction.fromBracket,
    effectiveContinueWorkRequests: requests,
    continuationWorkReason: extraction.workReason,
    internalBracketTraceparent: undefined,
    continuation,
    getActiveSessionEntry: () => activeEntry,
  });
}

const workRecords = async () => await listContinuationRecords({ kinds: ["work"] });
/** The system-event text the session's next turn takes into its prompt. */
const nextTurnEvents = async (sessionKey: string) =>
  await drainFormattedSystemEvents({
    cfg,
    agentId: "main",
    sessionKey,
    isMainSession: false,
    isNewSession: false,
  });

it("fails an incognito session's continue_work election visibly and elects nothing", async () => {
  await withState(async (env) => {
    const sessionKey = "agent:main:dashboard:incognito-election";
    const binding = await acquireSessionActorStorage(
      { agentId: "main", sessionKey, env },
      { authority, lifetime, create: true },
    );
    if (!binding) {
      throw new Error("Expected the incognito memory owner to admit creation");
    }
    try {
      const entry: SessionEntry = { sessionId: "incognito-head", updatedAt: 1, incognito: true };
      await commitMemory(binding.actor.storage, "session.entry.create", { entry });
      const runtimeLog = vi.spyOn(defaultRuntime, "log");
      expect(await workRecords()).toHaveLength(0);

      await runWithSessionActorStorage(binding, () =>
        electThroughTurn(sessionKey, binding.path, entry),
      );

      // The session's next turn, bound as the first, drains the notice into its prompt; the
      // capture's refusal is its cause.
      const drained = await runWithSessionActorStorage(binding, () => nextTurnEvents(sessionKey));
      expect(drained).toEqual(expect.stringMatching(SCHEDULING_FAILED));
      expect(runtimeLog).toHaveBeenCalledWith(
        expect.stringMatching(
          /continue_work scheduling failed after durable reservation .*Incognito collaboration command requires its dedicated owner/u,
        ),
      );
      expect(await workRecords()).toHaveLength(0);
      // The failed election released it; releasing every retained custody adds nothing.
      expect(operatorReleases).toHaveLength(1);
      expect(operatorReleases[0]).toHaveBeenCalledOnce();
      resetContinuationWorkDispatchForTests();
      expect(operatorReleases[0]).toHaveBeenCalledOnce();
      // Kept by design: the runner cannot tell how many of a failed batch's records committed, so
      // a throw after the reservation leaves its budget spent rather than let the chain exceed its
      // cap. It lives on the memory entry, which the next fresh turn resets and the session drops.
      const stored = memorySessionActorOwners
        .read({ agentId: "main", path: binding.path })
        ?.readSession(sessionKey, authority)?.entry;
      expect(stored?.continuationChainCount).toBe(1);
    } finally {
      await binding.actor.release();
    }
  });
});

it("binds a durable session's continue_work election to its recipient-authority epoch", async () => {
  await withState(async (env) => {
    const sessionKey = "agent:main:dashboard:durable-election";
    const scope = { agentId: "main", env, sessionKey };
    const entry = { sessionId: "durable-head", updatedAt: 1 };
    await accessor.upsertSessionEntryCore(scope, entry);
    expect(await workRecords()).toHaveLength(0);

    await electThroughTurn(
      sessionKey,
      resolveSessionStorePathCore(undefined, { agentId: "main" }),
      entry,
    );

    expect(await nextTurnEvents(sessionKey)).toBeUndefined();
    const [record, ...others] = await workRecords();
    expect(record && others).toEqual([]);
    // Insert-if-absent: returns the epoch the election captured.
    const epoch = await accessor.captureSessionRecipientAuthority(scope);
    expect(record && decodeWorkState(record)).toMatchObject({
      sessionKey,
      recipientAuthority: epoch,
      operatorAuthorityRequired: true,
    });
    // The custody went with the record, which retains it until its wake.
    expect(operatorReleases).toHaveLength(1);
    expect(operatorReleases[0]).not.toHaveBeenCalled();
  });
});
