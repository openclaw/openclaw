import { expect, it } from "vitest";
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

const enabledEnv = {
  [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
  [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "full",
  OPENAI_API_KEY: "test-key-placeholder",
};
const settings = (overrides: Record<string, string | undefined> = {}, live = true) =>
  resolveOpenAILongContextLiveSettings({ ...enabledEnv, ...overrides }, live);

it("stays disabled unless the dedicated gate is enabled", () => {
  expect(resolveOpenAILongContextLiveSettings({}, true)).toEqual({ enabled: false });
});

it("fails closed on incomplete gates, missing keys, and malformed profiles", () => {
  expect(() => settings({}, false)).toThrow("also requires OPENCLAW_LIVE_TEST=1");
  expect(() => settings({ OPENAI_API_KEY: undefined })).toThrow("requires OPENAI_API_KEY");
  expect(() => settings({ [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "huge" })).toThrow(
    "must be reduced or full",
  );
});
it("rejects a full-profile threshold mismatch", () => {
  const full = settings();
  if (!full.enabled) {
    throw new Error("expected enabled settings");
  }
  const { profile } = full;
  const cfg = buildOpenAILongContextConfig({ profile, workspace: "/workspace", agentId: "test" });
  expect(() =>
    assertOpenAILongContextConfig(cfg, { ...profile, compactThreshold: 735_000 }),
  ).toThrow("config mismatch");
});
it("returns only stable hashes and fence metadata", () => {
  const providerReplay = {
    type: "openai-responses-compaction",
    id: "cmp-secret-id",
    data: "opaque-ciphertext-secret",
    replayIndex: 2,
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.6-luna",
    baseUrlHash: "route-fence",
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
      replayIndex: 2,
      baseUrlHash: "route-fence",
      idHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
  });
  expect(JSON.stringify(observation)).not.toContain(providerReplay.id);
  expect(JSON.stringify(observation)).not.toContain(providerReplay.data);
});
it("creates exact bounded fixture bytes and validates redacted read evidence", () => {
  const fixture = buildToolOutputFixture({ marker: "TOOL-MARKER", bytes: 512_000 });
  expect(fixture.bytes).toBe(512_000);
  expect(fixture.content).toContain("TOOL-MARKER");
  const events = [
    {
      phase: "start",
      args: { file_path: "/tmp/workspace/.openclaw/tmp/tool-output.txt" },
    },
    {
      phase: "result",
      result: {
        content: [{ type: "text", text: "TOOL-MARKER|BEGIN|000000\nPRIVATE-TOOL-CONTENT" }],
        details: { kind: "truncated", truncation: { truncated: true, totalBytes: 512_000 } },
      },
    },
  ];
  const evidence = readToolOutputEvidence({
    events: events.map((data) => ({
      stream: "tool",
      data: { name: "read", toolCallId: "call-secret", ...data },
    })),
    expectedPath: ".openclaw/tmp/tool-output.txt",
    expectedMarker: "TOOL-MARKER",
    expectedBytes: fixture.bytes,
    fixtureHash: fixture.sha256,
  });
  expect(evidence.originalBytes).toBe(512_000);
  expect(JSON.stringify(evidence)).not.toContain("PRIVATE-TOOL-CONTENT");
  expect(JSON.stringify(evidence)).not.toContain("call-secret");
});
