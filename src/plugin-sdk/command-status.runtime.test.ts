import { beforeEach, describe, expect, it, vi } from "vitest";

const buildStatusReply = vi.fn<(params: unknown) => Promise<unknown>>();
const loadSessionEntry = vi.fn();
const resolveCurrentDirectiveLevels = vi.fn();

vi.mock("../auto-reply/reply/commands-status.js", () => ({
  buildStatusReply,
}));

// mock-isolation: command status tests supply config without reading operator state.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({}),
}));

// mock-isolation: command status tests control entry data without a live session store.
vi.mock("../gateway/session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: loadSessionEntry,
}));

// mock-isolation: keep status rendering on the synthetic agent rather than live agent discovery.
vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: () => [],
  resolveSessionAgentId: () => "main",
}));

// mock-isolation: use a fixed model without resolving provider configuration.
vi.mock("../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: () => ({ provider: "openai", model: "gpt-5.4" }),
}));

// mock-isolation: supply deterministic directive defaults without loading runtime model state.
vi.mock("../auto-reply/reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel: () => ({ defaultProvider: "openai", defaultModel: "gpt-5.4" }),
}));

// mock-isolation: provide synthetic thinking levels without consulting provider catalogs.
vi.mock("../auto-reply/reply/model-selection.js", () => ({
  createModelSelectionState: async () => ({
    resolveThinkingCatalog: async () => [],
    resolveDefaultThinkingLevel: async () => "off",
    resolveDefaultReasoningLevel: async () => "on",
  }),
}));

vi.mock("../auto-reply/reply/directive-handling.levels.js", () => ({
  resolveCurrentDirectiveLevels,
}));

const { resolveDirectStatusReplyForSessionCore } = await import("./command-status.runtime.js");

function loadedSession(cfg = {}, entry = {}) {
  return {
    cfg,
    canonicalKey: "main",
    entry: { sessionId: "sess-main", ...entry },
    store: {},
    storePath: "/tmp/sessions.json",
  };
}

const directiveLevels = (currentReasoningLevel: string) => ({
  currentThinkLevel: "off",
  currentFastMode: false,
  currentVerboseLevel: "off",
  currentReasoningLevel,
  currentElevatedLevel: "off",
});

const statusReply = (senderIsOwner: boolean, isAuthorizedSender: boolean) =>
  resolveDirectStatusReplyForSessionCore({
    cfg: {},
    sessionKey: "main",
    channel: "cli",
    senderIsOwner,
    isAuthorizedSender,
    isGroup: false,
    defaultGroupActivation: () => "always",
  });

describe("resolveDirectStatusReplyForSessionCore", () => {
  beforeEach(() => {
    buildStatusReply.mockReset().mockImplementation(async (params: unknown) => params);
    loadSessionEntry
      .mockReset()
      .mockResolvedValue(loadedSession({ agents: { defaults: { reasoningDefault: "off" } } }));
    resolveCurrentDirectiveLevels.mockReset().mockResolvedValue(directiveLevels("off"));
  });

  it("treats agentCfg reasoningDefault as explicit for direct /status", async () => {
    expect(await statusReply(true, true)).toMatchObject({ resolvedReasoningLevel: "off" });
  });

  it.each([
    { session: false, isAuthorizedSender: true },
    { session: false, isAuthorizedSender: false },
    { session: true, isAuthorizedSender: true },
    { session: true, isAuthorizedSender: false },
  ])(
    "gates reasoning: session=$session authorized=$isAuthorizedSender",
    async ({ session, isAuthorizedSender }) => {
      loadSessionEntry.mockResolvedValue(
        loadedSession(
          session ? {} : { agents: { defaults: { reasoningDefault: "stream" } } },
          session ? { reasoningLevel: "stream" } : {},
        ),
      );
      resolveCurrentDirectiveLevels.mockResolvedValueOnce(directiveLevels("stream"));
      expect(await statusReply(false, isAuthorizedSender)).toMatchObject({
        resolvedReasoningLevel: isAuthorizedSender ? "stream" : "off",
      });
    },
  );
});
