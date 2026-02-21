import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runAuthProbes } from "./list.probe.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: () => "/tmp/openclaw-agent",
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: () => "/tmp/openclaw-sessions",
  resolveSessionTranscriptPath: () => "/tmp/openclaw-sessions/probe-session.jsonl",
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({
    version: 1,
    profiles: {
      "openai:p1": { type: "api_key", provider: "openai", key: "sk-test" },
    },
    usageStats: {},
  }),
  listProfilesForProvider: () => ["openai:p1"],
  resolveAuthProfileDisplayLabel: () => "p1",
  resolveAuthProfileOrder: () => ["openai:p1"],
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: () => Promise.resolve([{ provider: "openai", id: "mock-1" }]),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getCustomProviderApiKey: () => undefined,
  resolveEnvApiKey: () => undefined,
}));

describe("runAuthProbes", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
  });

  it("runs embedded probes with explicit probe mode and probe lane/profile metadata", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const cfg = {
      agents: { defaults: { model: { fallbacks: [] } } },
      models: { providers: {} },
    } as OpenClawConfig;

    const summary = await runAuthProbes({
      cfg,
      providers: ["openai"],
      modelCandidates: ["openai/mock-1"],
      options: {
        timeoutMs: 2_000,
        concurrency: 1,
        maxTokens: 32,
      },
    });

    expect(summary.totalTargets).toBe(1);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);

    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      sessionId: string;
      probeMode?: boolean;
      lane?: string;
      authProfileId?: string;
      authProfileIdSource?: string;
    };

    expect(call.probeMode).toBe(true);
    expect(call.authProfileId).toBe("openai:p1");
    expect(call.authProfileIdSource).toBe("user");
    expect(call.lane).toBe("auth-probe:openai:openai:p1");
    expect(call.sessionId).toMatch(/^probe-openai-/);
  });
});
