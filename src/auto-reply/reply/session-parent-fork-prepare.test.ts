import { beforeEach, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions.js";

const forkMocks = vi.hoisted(() => ({
  forkSessionFromParent: vi.fn(async () => ({ sessionId: "forked-session" })),
  resolveParentForkDecision: vi.fn(async () => ({ status: "fork" })),
}));

vi.mock("./session-fork.js", () => forkMocks);

import { prepareReplySessionParentFork } from "./session-parent-fork-prepare.js";

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
