import { describe, expect, it } from "vitest";
import {
  OPENAI_LONG_CONTEXT_LIVE_ENV,
  OPENAI_LONG_CONTEXT_PROFILE_ENV,
  assertOpenAILongContextConfig,
  buildOpenAILongContextConfig,
  buildToolOutputFixture,
  observeOpenAICompactionEntries,
  readToolOutputEvidence,
  resolveOpenAILongContextLiveSettings,
} from "./openai-long-context-live.js";

const TEST_KEY = "test-key-placeholder";

function enabledSettings(profile: "reduced" | "full" = "full") {
  const settings = resolveOpenAILongContextLiveSettings(
    {
      [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
      [OPENAI_LONG_CONTEXT_PROFILE_ENV]: profile,
      OPENAI_API_KEY: TEST_KEY,
    },
    true,
  );
  if (!settings.enabled) {
    throw new Error("expected enabled settings");
  }
  return settings;
}

describe("OpenAI long-context live settings", () => {
  it("stays disabled unless the dedicated gate is enabled", () => {
    expect(resolveOpenAILongContextLiveSettings({}, false)).toEqual({ enabled: false });
    expect(resolveOpenAILongContextLiveSettings({}, true)).toEqual({ enabled: false });
  });

  it("fails closed on incomplete gates, missing keys, and malformed profiles", () => {
    expect(() =>
      resolveOpenAILongContextLiveSettings({ [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1" }, false),
    ).toThrow("also requires OPENCLAW_LIVE_TEST=1");
    expect(() =>
      resolveOpenAILongContextLiveSettings(
        {
          [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
          [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "full",
        },
        true,
      ),
    ).toThrow("requires OPENAI_API_KEY");
    expect(() =>
      resolveOpenAILongContextLiveSettings(
        {
          [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
          [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "huge",
          OPENAI_API_KEY: TEST_KEY,
        },
        true,
      ),
    ).toThrow("must be reduced or full");
  });
});

describe("OpenAI long-context config validation", () => {
  it("rejects a full-profile threshold mismatch", () => {
    const { profile } = enabledSettings("full");
    const cfg = buildOpenAILongContextConfig({
      profile,
      workspace: "/isolated/workspace",
      agentId: "long-context",
    });
    expect(() =>
      assertOpenAILongContextConfig(cfg, { ...profile, compactThreshold: 735_000 }),
    ).toThrow("config mismatch");
  });
});

describe("OpenAI compaction state observation", () => {
  it("returns only stable hashes and fence metadata", () => {
    const providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp-secret-id",
      data: "opaque-ciphertext-secret",
      replayIndex: 2,
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.6-luna",
      baseUrlHash: "route-fence",
      sessionHash: "session-fence",
      authProfileHash: "auth-fence",
    };
    const message = { role: "assistant", providerReplay };
    const observation = observeOpenAICompactionEntries({
      persistedEntries: [{ type: "message", message }],
      activeMessages: [message],
    });

    expect(observation).toMatchObject({
      persistedCount: 1,
      activeCount: 1,
      latest: {
        type: "openai-responses-compaction",
        replayIndex: 2,
        provider: "openai",
        model: "gpt-5.6-luna",
        baseUrlHash: "route-fence",
      },
    });
    expect(observation.latest?.idHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(observation.latest?.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(observation)).not.toContain(providerReplay.id);
    expect(JSON.stringify(observation)).not.toContain(providerReplay.data);
  });
});

describe("OpenAI deterministic large tool output", () => {
  it("creates exact bounded fixture bytes and validates redacted read evidence", () => {
    const fixture = buildToolOutputFixture({ marker: "TOOL-MARKER", bytes: 512_000 });
    expect(fixture.bytes).toBe(512_000);
    expect(fixture.content).toContain("TOOL-MARKER");
    const events = [
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "read",
          toolCallId: "call-secret",
          args: { file_path: "/tmp/workspace/.openclaw/tmp/tool-output.txt" },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          name: "read",
          toolCallId: "call-secret",
          isError: false,
          result: {
            content: [{ type: "text", text: "TOOL-MARKER|BEGIN|000000\nPRIVATE-TOOL-CONTENT" }],
            details: {
              kind: "truncated",
              truncation: { truncated: true, totalBytes: 512_000 },
            },
          },
        },
      },
    ];
    const evidence = readToolOutputEvidence({
      events,
      expectedPath: ".openclaw/tmp/tool-output.txt",
      expectedMarker: "TOOL-MARKER",
      expectedBytes: fixture.bytes,
      fixtureHash: fixture.sha256,
    });
    expect(evidence).toMatchObject({
      path: ".openclaw/tmp/tool-output.txt",
      marker: "TOOL-MARKER",
      originalBytes: 512_000,
      fixtureHash: fixture.sha256,
    });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-TOOL-CONTENT");
    expect(JSON.stringify(evidence)).not.toContain("call-secret");
  });
});
