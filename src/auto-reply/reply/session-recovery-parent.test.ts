// Restart-recovery replacement via the explicit recovery parent key (#176224).
// Lives outside session.test.ts: that file is over its line cap, so new tests
// for the recovery parent key get a coherent sibling module.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  initSessionState,
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
  forkSessionFromParent: sessionForkMocks.forkSessionFromParent,
}));

vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  closeTrackedBrowserTabsForSessions: browserMaintenanceMocks.closeTrackedBrowserTabsForSessions,
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/hook-runner-global.js")>()),
  getGlobalHookRunner: () => null,
}));

vi.mock("../../infra/channel-summary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/channel-summary.js")>()),
  buildChannelSummary: channelSummaryMocks.buildChannelSummary,
}));

vi.mock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-catalog.js")>()),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.7", name: "M2.7" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

const suiteRoot = useSessionStoreTempDirs(afterAll, "openclaw-session-recovery-").make();
let suiteCase = 0;

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

beforeEach(() => {
  channelSummaryMocks.buildChannelSummary.mockReset().mockResolvedValue([]);
  browserMaintenanceMocks.closeTrackedBrowserTabsForSessions.mockReset().mockResolvedValue(0);
  sessionForkMocks.nextSessionId = 0;
  sessionForkMocks.forkSessionFromParent
    .mockReset()
    .mockImplementation(async ({ sessionKey }: ForkSessionParamsForTest) => {
      const sessionId = `forked-session-${++sessionForkMocks.nextSessionId}`;
      return { sessionId, sessionFile: sessionKey };
    });
});

describe("initSessionState recovery parent key", () => {
  it("fences a model-only parent from restart-recovery replacement", async () => {
    const storePath = await makeStorePath("openclaw-model-only-tombstone-fence-");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:isolated";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: { sessionId: "parent-session", updatedAt: Date.now() },
      [threadSessionKey]: {
        sessionId: "tombstoned-thread-session",
        updatedAt: Date.now(),
        mainRestartRecovery: {
          cycleId: "old-cycle",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "old transcript exhausted" },
        },
      },
    });

    // ModelParentSessionKey is descriptive (model/provider overrides only) and
    // must not grant parent lifecycle behavior. Discord emits it for threads
    // with transcript inheritance disabled; those turns stay fenced pending reset.
    await expect(
      initSessionState({
        ctx: {
          Body: "Thread reply",
          SessionKey: threadSessionKey,
          ModelParentSessionKey: parentSessionKey,
          InboundAccessAuthorized: true,
          InboundEventKind: "user_request",
          InputProvenance: { kind: "external_user", sourceChannel: "slack" },
        },
        cfg: { session: { store: storePath } } as OpenClawConfig,
      }),
    ).rejects.toThrow(/ended during restart recovery/i);
    expect(loadSessionEntry({ storePath, sessionKey: threadSessionKey })).toMatchObject({
      sessionId: "tombstoned-thread-session",
      mainRestartRecovery: { tombstone: { reason: "old transcript exhausted" } },
    });
    expect(sessionForkMocks.forkSessionFromParent).not.toHaveBeenCalled();
  });

  it("replaces a restart tombstone from the recovery parent key with required fork preparation", async () => {
    const storePath = await makeStorePath("openclaw-recovery-parent-tombstone-fork-");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:recovering";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: { sessionId: "parent-session", updatedAt: Date.now() },
      [threadSessionKey]: {
        sessionId: "tombstoned-thread-session",
        updatedAt: Date.now(),
        mainRestartRecovery: {
          cycleId: "old-cycle",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "old transcript exhausted" },
        },
      },
    });

    // The recovery parent key explicitly authorizes replacement: the required
    // parent-fork preparation must run before the fresh generation commits.
    const initialized = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        RecoveryParentSessionKey: parentSessionKey,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "slack" },
      },
      cfg: { session: { store: storePath } } as OpenClawConfig,
    });

    expect(sessionForkMocks.forkSessionFromParent).toHaveBeenCalledTimes(1);
    expect(sessionForkMocks.forkSessionFromParent.mock.calls[0]?.[0]).toMatchObject({
      parentSessionKey,
      sessionKey: threadSessionKey,
    });
    expect(initialized.sessionEntry).toMatchObject({
      sessionId: "forked-session-1",
      forkedFromParent: true,
      forkSource: { sessionKey: parentSessionKey, sessionId: "parent-session" },
    });
    expect(loadSessionEntry({ storePath, sessionKey: threadSessionKey })).toMatchObject({
      sessionId: "forked-session-1",
    });
  });
});
