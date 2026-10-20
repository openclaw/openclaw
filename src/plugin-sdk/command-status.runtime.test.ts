import { beforeEach, describe, expect, it, vi } from "vitest";

const buildStatusReply = vi.fn(async (params: unknown) => params);
const loadSessionEntry = vi.fn();
const resolveSessionAgentId = vi.fn();
const listAgentEntries = vi.fn();
const resolveDefaultModelForAgent = vi.fn();
const resolveDefaultModel = vi.fn();
const createModelSelectionState = vi.fn();
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

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries,
  resolveSessionAgentId,
}));

vi.mock("../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent,
}));

vi.mock("../auto-reply/reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel,
}));

vi.mock("../auto-reply/reply/model-selection.js", () => ({
  createModelSelectionState,
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
    buildStatusReply.mockReset();
    loadSessionEntry.mockReset();
    resolveSessionAgentId.mockReset();
    listAgentEntries.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveDefaultModel.mockReset();
    createModelSelectionState.mockReset();
    resolveCurrentDirectiveLevels.mockReset();

    buildStatusReply.mockImplementation(async (params: unknown) => params);
    loadSessionEntry.mockResolvedValue(
      loadedSession({ agents: { defaults: { reasoningDefault: "off" } } }),
    );
    resolveSessionAgentId.mockReturnValue("main");
    listAgentEntries.mockReturnValue([]);
    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    resolveDefaultModel.mockReturnValue({ defaultProvider: "openai", defaultModel: "gpt-5.4" });
    createModelSelectionState.mockResolvedValue({
      resolveThinkingCatalog: vi.fn(async () => []),
      resolveDefaultThinkingLevel: vi.fn(async () => "off"),
      resolveDefaultReasoningLevel: vi.fn(async () => "on"),
    });
    resolveCurrentDirectiveLevels.mockResolvedValue(directiveLevels("off"));
  });

  it("treats agentCfg reasoningDefault as explicit for direct /status", async () => {
    const result = await statusReply(true, true);

    expect(buildStatusReply).toHaveBeenCalledOnce();
    expect(buildStatusReply.mock.calls[0]?.[0]).toMatchObject({ resolvedReasoningLevel: "off" });
    expect(result).toMatchObject({ resolvedReasoningLevel: "off" });
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
