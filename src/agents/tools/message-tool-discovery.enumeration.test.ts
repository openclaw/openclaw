import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), plugin: vi.fn() }));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryReadOnlyInWorker: mocks.read,
}));
vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (_store: unknown, opts?: { agentId?: string }) =>
    `/tmp/${opts?.agentId ?? "main"}-sessions.sqlite`,
}));
vi.mock("../../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/main-sessions.sqlite" },
    { agentId: "main", storePath: "/tmp/secondary-sessions.sqlite" },
  ],
}));
vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: mocks.plugin,
}));
import { resolveEffectiveCurrentChannelContextForRequest } from "./message-tool-discovery.js";

const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;
beforeEach(() => {
  mocks.read.mockReset().mockImplementation(({ sessionKey }: { sessionKey: string }) =>
    sessionKey === SESSION_KEY
      ? {
          sessionId: "s1",
          updatedAt: 1,
          delivery: {
            kind: "external",
            context: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
          },
        }
      : undefined,
  );
  mocks.plugin.mockReset().mockReturnValue({
    config: { listAccountIds: () => ["default"] },
    messaging: { targetIdComparison: "case-sensitive" },
  });
});
it.each([
  {
    name: "recovers canonical casing",
    sessionId: undefined,
    lowercase: false,
    target: CANONICAL_SPACE,
    reads: [SESSION_KEY],
  },
  {
    name: "rejects a replacement session",
    sessionId: "previous-session",
    lowercase: false,
    target: FOLDED_SPACE,
    reads: [SESSION_KEY],
  },
  {
    name: "does not read lowercase-canonical channels",
    sessionId: undefined,
    lowercase: true,
    target: FOLDED_SPACE,
    reads: [],
  },
])("$name without enumerating the store", async ({ sessionId, lowercase, target, reads }) => {
  if (lowercase) {
    mocks.plugin.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
  }
  const result = await resolveEffectiveCurrentChannelContextForRequest(
    { currentChannelProvider: "webchat", agentSessionKey: SESSION_KEY, sessionId },
    { config: {}, action: "send", params: {} },
  );
  expect(result).toMatchObject({ currentChannelId: target, currentMessagingTarget: target });
  expect(mocks.read.mock.calls.map(([scope]) => scope.sessionKey)).toEqual(reads);
});
