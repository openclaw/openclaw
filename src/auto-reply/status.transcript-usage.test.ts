import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { readRecentSessionUsageFromTranscriptAsync } from "../gateway/session-transcript-usage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  buildStatusMessage as buildStatusMessageRaw,
  statusModelRefs,
} from "../status/status-message.test-support.js";

type StatusArgs = Parameters<typeof buildStatusMessageRaw>[0];
type StatusTestArgs = Omit<Partial<StatusArgs>, "sessionEntry"> & {
  sessionEntry?: Partial<NonNullable<StatusArgs["sessionEntry"]>>;
};
const statusContext = {
  sessionKey: "agent:main:main",
  sessionScope: "per-sender",
  queue: { mode: "collect", depth: 0 },
} as const;

function buildStatusMessage({ sessionEntry, ...args }: StatusTestArgs): string {
  return buildStatusMessageRaw({
    ...statusContext,
    modelAuth: "api-key",
    activeModelAuth: "api-key",
    modelRefs: statusModelRefs({ provider: "anthropic", model: "claude-opus-4-6" }),
    agent: { model: "anthropic/claude-opus-4-6" },
    ...args,
    sessionEntry: sessionEntry && { sessionId: "status", updatedAt: 0, ...sessionEntry },
  });
}
function modelArgs(provider: string, model: string): Pick<StatusArgs, "modelRefs" | "agent"> {
  return {
    modelRefs: statusModelRefs({ provider, model }),
    agent: { model: `${provider}/${model}` },
  };
}
beforeEach(() =>
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  }),
);
afterEach(() => cliBackendsTesting.resetDepsForTest());

async function buildTranscriptUsageStatusMessage(args: StatusTestArgs): Promise<string> {
  const sessionId = args.sessionEntry?.sessionId;
  if (!sessionId) {
    throw new Error("Transcript status needs a session id");
  }
  const sessionKey = "sessionKey" in args ? args.sessionKey : statusContext.sessionKey;
  const agentId =
    args.agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
  const transcriptUsage = await readRecentSessionUsageFromTranscriptAsync(
    {
      agentId,
      sessionId,
      sessionKey,
      storePath: resolveSessionStorePathCore(undefined, { agentId }),
    },
    256 * 1024,
  );
  return buildStatusMessage({ ...args, transcriptUsage });
}

function withStatusHome(run: () => Promise<void>) {
  return withTempHome(run, { prefix: "openclaw-status-" });
}

describe("status transcript usage and model context", () => {
  function writeTranscriptUsageLog(params: {
    agentId: string;
    sessionId: string;
    model?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  }) {
    const scope = {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: `agent:${params.agentId}:main`,
      storePath: resolveSessionStorePathCore(undefined, { agentId: params.agentId }),
    };
    replaceSessionEntrySync(scope, { sessionId: params.sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      message: {
        role: "assistant",
        model: params.model ?? "claude-opus-4-6",
        usage: params.usage ?? baselineTranscriptUsage,
      },
    });
  }

  const baselineTranscriptUsage = {
    input: 1,
    output: 2,
    cacheRead: 1000,
    cacheWrite: 0,
    totalTokens: 1003,
  } as const;

  async function buildTranscriptStatusText(params: { sessionId: string; sessionKey: string }) {
    return buildTranscriptUsageStatusMessage({
      sessionEntry: {
        sessionId: params.sessionId,
        totalTokens: 3,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        agentHarnessId: "openclaw",
        contextTokens: 32_000,
        contextTokensSource: "runtime",
      },
      sessionKey: params.sessionKey,
      resolvedHarness: "openclaw",
    });
  }

  it("reads transcript usage for non-default agents", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-worker1";
      writeTranscriptUsageLog({ agentId: "worker1", sessionId });
      const text = await buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:worker1:telegram:12345",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      appendTranscriptMessageSync(
        {
          agentId: "worker1",
          sessionId,
          sessionKey: "agent:worker1:main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "worker1" }),
        },
        { message: { role: "assistant", usage: { input: 2_000, output: 20, totalTokens: 2_000 } } },
      );
      const updated = await buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:worker1:telegram:12345",
      });
      expect(normalizeTestText(updated)).toContain("Context: 2.0k/32k");
    });
  });

  it("does not render stale context usage from transcript fallback", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-stale-transcript-context";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        usage: {
          input: 3_800_000,
          output: 20_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3_820_000,
        },
      });

      const text = await buildTranscriptUsageStatusMessage({
        sessionEntry: {
          sessionId,

          inputTokens: 3_800_000,
          outputTokens: 20_000,
          totalTokens: 3_800_000,
          totalTokensFresh: false,
          contextTokens: 1_000_000,
        },
      });
      const normalized = normalizeTestText(text);

      expect(normalized).toContain("Context: ?/1.0m");
      expect(normalized).not.toContain("Context: 3.8m/1.0m");
      expect(normalized).not.toContain("Context: 3.82m/1.0m");
    });
  });

  it("does not let legacy cumulative session totals override fresh transcript context usage", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-legacy-cumulative-context";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        usage: {
          input: 10_000,
          output: 1_000,
          cacheRead: 26_000,
          cacheWrite: 0,
          totalTokens: 36_000,
        },
      });

      const text = await buildTranscriptUsageStatusMessage({
        sessionEntry: {
          sessionId,

          inputTokens: 16,
          outputTokens: 5_100,
          cacheRead: 2_300_000,
          cacheWrite: 11_000,
          totalTokens: 2_300_000,
          contextTokens: 1_000_000,
        },
      });
      const normalized = normalizeTestText(text);

      expect(normalized).toContain("Cache: 100% hit · 2.3m cached, 11k new");
      expect(normalized).toContain("Context: 36k/1.0m (4%)");
      expect(normalized).not.toContain("Context: 2.3m/1.0m");
    });
  });

  it("reads transcript usage using explicit agentId when sessionKey is missing", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-worker2";
      writeTranscriptUsageLog({
        agentId: "worker2",
        sessionId,
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1200,
          cacheWrite: 0,
          totalTokens: 1205,
        },
      });

      const text = await buildTranscriptUsageStatusMessage({
        agentId: "worker2",
        sessionEntry: {
          sessionId,
          totalTokens: 5,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          agentHarnessId: "openclaw",
          contextTokens: 32_000,
          contextTokensSource: "runtime",
        },
        sessionKey: undefined,
        resolvedHarness: "openclaw",
      });

      expect(normalizeTestText(text)).toContain("Context: 1.2k/32k");
    });
  });

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-cache-delivery-mirror";
      writeTranscriptUsageLog({ agentId: "main", sessionId });
      appendTranscriptMessageSync(
        {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
        {
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
            },
          },
        },
      );

      const text = await buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:main:main",
      });

      expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });

  it("keeps transcript-derived slash model ids in their admitted provider catalog", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-openrouter-google";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        model: "google/gemini-2.5-pro",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1200,
          cacheWrite: 0,
          totalTokens: 1205,
        },
      });

      const text = await buildTranscriptUsageStatusMessage({
        ...modelArgs("openrouter", "google/gemini-2.5-pro"),
        thinkingCatalog: [
          { provider: "openrouter", id: "google/gemini-2.5-pro", contextWindow: 999_000 },
          { provider: "google", id: "gemini-2.5-pro", contextWindow: 2_000_000 },
        ],
        config: {
          models: {
            providers: {
              google: {
                models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
              },
            },
          },
        } as unknown as OpenClawConfig,
        sessionEntry: {
          sessionId,
          totalTokens: 5,
        },
      });

      const normalized = normalizeTestText(text);
      expect(normalized).toContain("Context: 1.2k/999k");
      expect(normalized).not.toContain("Context: 1.2k/2.0m");
    });
  });

  it("keeps runtime slash model ids in their admitted provider catalog when modelProvider is missing", () => {
    const text = buildStatusMessage({
      ...modelArgs("openrouter", "google/gemini-2.5-pro"),
      thinkingCatalog: [
        { provider: "openrouter", id: "google/gemini-2.5-pro", contextWindow: 999_000 },
        { provider: "google", id: "gemini-2.5-pro", contextWindow: 2_000_000 },
      ],
      config: {
        models: {
          providers: {
            google: {
              models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {
        totalTokens: 1205,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        model: "google/gemini-2.5-pro",
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    const text = buildStatusMessage({
      modelRefs: statusModelRefs(
        { provider: "xiaomi", model: "mimo-v2-flash" },
        { provider: "fake-minimax", model: "FakeMiniMax-M2.5" },
      ),
      config: {
        models: {
          providers: {
            "fake-minimax": {
              models: [{ id: "FakeMiniMax-M2.5", contextWindow: 777_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        model: "fake-minimax/FakeMiniMax-M2.5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "xiaomi/mimo-v2-flash",
          activeModel: "fake-minimax/FakeMiniMax-M2.5",
          reason: "model not allowed",
        },
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: fake-minimax/FakeMiniMax-M2.5");
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for non-fallback runtime slash ids", () => {
    const text = buildStatusMessage({
      ...modelArgs("openai", "gpt-4o"),
      config: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-4o", contextWindow: 777_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      sessionEntry: {
        model: "openai/gpt-4o",
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
  });

  it("keeps bare transcript model ids in their admitted provider catalog", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-google-bare-model";
      writeTranscriptUsageLog({
        agentId: "main",
        sessionId,
        model: "gemini-2.5-pro",
        usage: {
          input: 2,
          output: 3,
          cacheRead: 1200,
          cacheWrite: 0,
          totalTokens: 1205,
        },
      });

      const text = await buildTranscriptUsageStatusMessage({
        ...modelArgs("google-gemini-cli", "gemini-2.5-pro"),
        thinkingCatalog: [
          { provider: "google-gemini-cli", id: "gemini-2.5-pro", contextWindow: 1_000_000 },
          { provider: "google", id: "gemini-2.5-pro", contextWindow: 128_000 },
        ],
        sessionEntry: {
          sessionId,
          totalTokens: 5,
        },
      });

      const normalized = normalizeTestText(text);
      expect(normalized).toContain("Context: 1.2k/1.0m");
      expect(normalized).not.toContain("Context: 1.2k/128k");
    });
  });
});
