import { beforeEach, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions.js";

const forkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(async () => ({ sessionId: "forked-session" })),
  resolveParentForkDecision: vi.fn(async () => ({ status: "fork" })),
}));

vi.mock("./session-fork.js", () => forkMocks);

import {
  canReplaceRestartTombstoneFromParent,
  prepareReplySessionParentFork,
} from "./session-parent-fork-prepare.js";

const prepare = (overrides: Partial<Parameters<typeof prepareReplySessionParentFork>[0]>) =>
  prepareReplySessionParentFork({
    agentId: "main",
    alreadyForked: false,
    parentSessionKey: "agent:main:parent",
    readEntry: () => ({ sessionId: "parent-session", updatedAt: 1 }),
    sessionEntry: { sessionId: "provisional-session", updatedAt: 2 },
    sessionKey: "agent:main:child",
    storePath: "/tmp/sessions.json",
    warn: vi.fn(),
    ...overrides,
  });

beforeEach(() => vi.clearAllMocks());

it("requires human mutation authority for tombstone parent replacement", () => {
  const entry: InternalSessionEntry = {
    sessionId: "tombstoned-session",
    updatedAt: 1,
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 4,
      chargedAttempts: 3,
      tombstone: { reason: "automatic recovery exhausted" },
    },
  };
  const allowed = {
    actorType: "human" as const,
    entry,
    hasParentForkSource: true,
    inboundAccessAuthorized: true,
    inboundEventKind: "user_request",
    sessionKey: "agent:main:child",
  };

  expect(canReplaceRestartTombstoneFromParent(allowed)).toBe(true);
  const denials: Partial<Parameters<typeof canReplaceRestartTombstoneFromParent>[0]>[] = [
    { entry: { ...entry, modelSelectionLocked: true } },
    { inboundAccessAuthorized: false },
    { inboundEventKind: "room_event" },
    { actorType: "system" },
    { hasPluginOwnedBinding: true },
    { nativeCommandTarget: "agent:main:other" },
  ];
  for (const denial of denials) {
    expect(canReplaceRestartTombstoneFromParent({ ...allowed, ...denial })).toBe(false);
  }
});

it("clears run identities when the parent fork replaces the transcript generation", async () => {
  const sessionEntry: InternalSessionEntry = {
    sessionId: "provisional-session",
    updatedAt: 2,
    lifecycleRunId: "active-provisional-run",
    lastRunId: "settled-provisional-run",
  };

  const result = await prepare({ sessionEntry });
  expect(result).toMatchObject({
    sessionId: "forked-session",
    lifecycleRunId: undefined,
    lastRunId: undefined,
  });
});

it("rejects required replacement when the parent disappears before commit", async () => {
  await expect(
    prepare({
      readEntry: () => undefined,
      requireParentForkReplacement: true,
    }),
  ).rejects.toThrow(/ended during restart recovery/i);
  expect(forkMocks.resolveParentForkDecision).not.toHaveBeenCalled();
  expect(forkMocks.forkSessionFromParent).not.toHaveBeenCalled();
});
