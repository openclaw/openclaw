// Tests continuation custody across reply session resets (explicit, inline, implicit rollover).
// Harness mirrored from session.test.ts so these cases run under identical mocks.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { captureSessionRecipientAuthority } from "../../config/sessions/session-accessor.js";
import { isSessionRecipientAuthorityCurrentInWorker } from "../../config/sessions/session-recipient-authority-current.js";
import { testing as sessionBindingTesting } from "../../infra/outbound/session-binding-service.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  readCustodyRecordForTest,
  useContinuationCustodyTestState,
} from "../continuation/custody/custody.test-support.js";
import { consumePendingDelegates, enqueuePendingDelegate } from "../continuation/delegate-store.js";
import { decodeWorkState, type PendingContinuationWork } from "../continuation/work-flow-state.js";
import { enqueuePendingWorkReplacing } from "../continuation/work-replacement-store.js";
import { consumePendingWork } from "../continuation/work-store.js";
import {
  initSessionState,
  runExplicitResetCases,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

const sessionForkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(),
  nextSessionId: 0,
}));
const channelSummaryMocks = vi.hoisted(() => ({
  buildChannelSummary: vi.fn(async () => [] as string[]),
}));
const browserMaintenanceMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForSessions: vi.fn(async () => 0),
}));

type ForkSessionParamsForTest = {
  parentEntry: SessionEntry;
  sessionKey: string;
};

vi.mock("./session-fork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-fork.js")>()),
  forkSessionFromParent: (...args: [ForkSessionParamsForTest]) =>
    sessionForkMocks.forkSessionFromParent(...args),
}));

// mock-isolation: Tab cleanup is recorded without loading the browser plugin facade.
vi.mock("../../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
}));

// mock-isolation: No global hook runner is installed, so plugin hooks never run.
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

// mock-isolation: Channel summaries come from the test; the real builder inspects channel plugin accounts.
vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: channelSummaryMocks.buildChannelSummary,
}));

// mock-isolation: A fixed model catalog replaces the prepared runtime catalog, which reads config and auth.
vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.7", name: "M2.7" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string, agentId?: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  const sessionsDir = agentId ? path.join(root, "agents", agentId, "sessions") : root;
  return path.join(sessionsDir, "sessions.json");
}

// Seed queued work through the real custody election path.
async function enqueuePendingWork(work: PendingContinuationWork): Promise<PendingContinuationWork> {
  const result = await enqueuePendingWorkReplacing({
    work,
    summary: "seeded session test work",
    maxPendingWork: Number.MAX_SAFE_INTEGER,
    replaceParkedWork: false,
    expectedRunningFlowIds: [],
  });
  if (!result.applied) {
    throw new Error("expected seeded continuation work to be elected");
  }
  return result.work;
}

function expectEntryFields(
  entry: SessionEntry,
  expected: Record<string, unknown>,
  label?: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect((entry as unknown as Record<string, unknown>)[key], label ?? key).toEqual(value);
  }
}

beforeEach(() => {
  channelSummaryMocks.buildChannelSummary.mockReset().mockResolvedValue([]);
  browserMaintenanceMocks.closeTrackedBrowserTabsForSessions.mockReset().mockResolvedValue(0);
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  sessionForkMocks.nextSessionId = 0;
  sessionForkMocks.forkSessionFromParent
    .mockReset()
    .mockImplementation(async ({ sessionKey }: ForkSessionParamsForTest) => {
      const sessionId = `forked-session-${++sessionForkMocks.nextSessionId}`;
      return { sessionId, sessionFile: sessionKey };
    });
});
afterEach(async () => {
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  await closeOpenClawStateDatabaseAsync();
});
describe("initSessionState guarded initialization", () => {
  // Upstream session.test.ts case (U:591), restored here; see PR-NOTES F1 for the registry clause.
  it("waits for real settlement when reply cancellation throws after committing abort", async () => {
    const storePath = await makeStorePath("openclaw-session-init-reset-cancel-failure-");
    const sessionKey = "agent:main:matrix:channel:cancel-failure";
    const sessionId = "committed-reset-session";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    });
    const cancellationAttempted = createDeferred();
    const cancel = vi.fn(() => {
      cancellationAttempted.resolve();
      throw new Error("backend cancellation failed");
    });
    const activeReply = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    activeReply.attachBackend({ kind: "embedded", cancel, isStreaming: () => false });
    activeReply.setPhase("running");

    try {
      const initialization = initSessionState({
        ctx: {
          Body: "/new",
          RawBody: "/new",
          CommandBody: "/new",
          From: "@owner:example.test",
          To: "!cancel-failure:example.test",
          ChatType: "channel",
          SessionKey: sessionKey,
          Provider: "matrix",
          Surface: "matrix",
        },
        cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
        commandAuthorized: true,
      });
      await cancellationAttempted.promise;
      activeReply.complete();
      const reset = await initialization;

      expect(reset.resetTriggered).toBe(true);
      expect(cancel).toHaveBeenCalledWith("restart");
      expect(isSessionRunActiveForKey(sessionKey)).toBe(false);
    } finally {
      activeReply.complete();
    }
  });
});

describe("initSessionState reset policy", () => {
  useContinuationCustodyTestState();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "idle",
      now: new Date(2026, 0, 18, 5, 30, 0),
      updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      reset: { mode: "idle" as const, idleMinutes: 30 },
    },
    {
      name: "daily",
      now: new Date(2026, 0, 18, 5, 0, 0),
      updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      reset: { mode: "daily" as const, atHour: 4 },
    },
  ])("preserves durable continuation claims across implicit $name rollover", async (scenario) => {
    vi.setSystemTime(scenario.now);
    const storePath = await makeStorePath(`openclaw-reset-${scenario.name}-continuation-`);
    const sessionKey = `agent:main:whatsapp:dm:${scenario.name}-continuation`;
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: `${scenario.name}-continuation-session`,
        updatedAt: scenario.updatedAt,
      },
    });
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
    });
    await enqueuePendingDelegate(sessionKey, {
      task: `continue after ${scenario.name} rollover`,
      delayMs: 0,
    });

    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg: { session: { store: storePath, reset: scenario.reset } } as OpenClawConfig,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(await consumePendingWork(sessionKey)).toHaveLength(1);
    expect(await consumePendingDelegates(sessionKey)).toHaveLength(1);
  });
});

describe("initSessionState browser tab cleanup", () => {
  useContinuationCustodyTestState();
  // #1271: an inline /new replaces the head; the queued elections stay for its successor.
  it("keeps queued continuation work and delegates on inline reset", async () => {
    const storePath = await makeStorePath("openclaw-inline-reset-continuation-");
    const sessionKey = "agent:main:telegram:dm:inline-reset-continuation";
    const existingSessionId = "inline-reset-continuation-session";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now(),
      },
    });
    const scope = { agentId: "main", sessionKey, storePath };
    const recipientAuthority = await captureSessionRecipientAuthority(scope);
    const work = await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 60_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 60_000,
      maxChainLength: 8,
      recipientAuthority,
    });
    const delegate = await enqueuePendingDelegate(sessionKey, {
      task: "delegate after inline reset",
      delayMs: 60_000,
    });
    if (!work.flowId) {
      throw new Error("expected durable continuation records");
    }

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        SessionKey: sessionKey,
      },
      cfg: { session: { store: storePath, idleMinutes: 999 } } as OpenClawConfig,
    });

    expect(result.isNewSession).toBe(true);
    const kept = await readCustodyRecordForTest(work.flowId);
    expect(kept?.status).toBe("queued");
    expect((await readCustodyRecordForTest(delegate.recordId))?.status).toBe("queued");
    // The same-owner /new leaves the epoch the kept wake is bound to current.
    expect(decodeWorkState(kept!)?.recipientAuthority).toEqual(recipientAuthority);
    expect(await isSessionRecipientAuthorityCurrentInWorker(scope, recipientAuthority)).toBe(true);
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  it("preserves behavior overrides across /new and /reset", async () => {
    const storePath = await makeStorePath("openclaw-reset-overrides-");
    const sessionKey = "agent:main:telegram:dm:user-overrides";
    const existingSessionId = "existing-session-overrides";
    const overrides = {
      verboseLevel: "on",
      thinkingLevel: "high",
      reasoningLevel: "low",
      label: "telegram-priority",
      lastContextPressureBand: 95,
      pendingPostCompactionDelegates: [{ task: "carry notes", createdAt: 1 }],
    } as const;
    const cases = await runExplicitResetCases({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      entry: overrides,
    });

    for (const { name, result } of cases) {
      expect(result.isNewSession, name).toBe(true);
      expect(result.resetTriggered, name).toBe(true);
      expect(result.sessionId, name).toBe(existingSessionId);
      expectEntryFields(
        result.sessionEntry,
        {
          verboseLevel: overrides.verboseLevel,
          thinkingLevel: overrides.thinkingLevel,
          reasoningLevel: overrides.reasoningLevel,
          label: overrides.label,
        },
        name,
      );
      // Reset keeps durable transcript identity upstream, while continuation
      // telemetry and queued post-compaction work must not leak into the new turn.
      expect(result.sessionEntry.lastContextPressureBand, name).toBeUndefined();
      expect(result.sessionEntry.pendingPostCompactionDelegates, name).toBeUndefined();
    }
  });
});
