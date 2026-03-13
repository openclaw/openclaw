import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import { createReplyPrefixContext } from "./reply-prefix.js";

const identityMocks = vi.hoisted(() => ({
  resolveEffectiveMessagesConfig: vi.fn(() => ({ responsePrefix: "[{model} | {thinkingLevel}]" })),
  resolveIdentityName: vi.fn(() => "Alex"),
}));

const sessionMocks = vi.hoisted(() => ({
  resolveStorePath: vi.fn(() => "/tmp/mock-sessions.json"),
  loadSessionStore: vi.fn(() => ({})),
  resolveSessionStoreEntry: vi.fn(() => ({ existing: undefined })),
}));

vi.mock("../agents/identity.js", () => ({
  resolveEffectiveMessagesConfig: identityMocks.resolveEffectiveMessagesConfig,
  resolveIdentityName: identityMocks.resolveIdentityName,
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: sessionMocks.resolveStorePath,
  loadSessionStore: sessionMocks.loadSessionStore,
  resolveSessionStoreEntry: sessionMocks.resolveSessionStoreEntry,
}));

describe("createReplyPrefixContext", () => {
  beforeEach(() => {
    identityMocks.resolveEffectiveMessagesConfig.mockClear();
    identityMocks.resolveIdentityName.mockClear();
    sessionMocks.resolveStorePath.mockClear();
    sessionMocks.loadSessionStore.mockClear();
    sessionMocks.resolveSessionStoreEntry.mockClear();
    sessionMocks.resolveSessionStoreEntry.mockReturnValue({ existing: undefined });
  });

  it("seeds response prefix template context from stored session runtime metadata", () => {
    sessionMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: {
        modelProvider: "groq",
        model: "moonshotai/kimi-k2.5-instruct",
        thinkingLevel: "off",
      },
    });

    const result = createReplyPrefixContext({
      cfg: {},
      agentId: "main",
      channel: "whatsapp",
      sessionKey: "main",
    });

    expect(
      resolveResponsePrefixTemplate(result.responsePrefix, result.responsePrefixContextProvider()),
    ).toBe("[kimi-k2.5-instruct | off]");
    expect(sessionMocks.resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
    expect(sessionMocks.resolveSessionStoreEntry).toHaveBeenCalledWith({
      store: {},
      sessionKey: "main",
    });
  });

  it("falls back to parsing provider from legacy runtime model strings", () => {
    sessionMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: {
        model: "openai-codex/gpt-5.4",
      },
    });

    const result = createReplyPrefixContext({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
    });

    expect(result.responsePrefixContextProvider()).toEqual({
      identityName: "Alex",
      provider: "openai-codex",
      model: "gpt-5.4",
      modelFull: "openai-codex/gpt-5.4",
      thinkingLevel: "off",
    });
  });

  it("prefers actual model selection once the run starts", () => {
    sessionMocks.resolveSessionStoreEntry.mockReturnValue({
      existing: {
        modelProvider: "groq",
        model: "moonshotai/kimi-k2.5-instruct",
        thinkingLevel: "off",
      },
    });

    const result = createReplyPrefixContext({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
    });

    result.onModelSelected({
      provider: "openai-codex",
      model: "gpt-5.4-20260301",
      thinkLevel: "high",
    });

    expect(
      resolveResponsePrefixTemplate(result.responsePrefix, result.responsePrefixContextProvider()),
    ).toBe("[gpt-5.4 | high]");
    expect(result.responsePrefixContextProvider()).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.4",
      modelFull: "openai-codex/gpt-5.4-20260301",
      thinkingLevel: "high",
    });
  });
});
