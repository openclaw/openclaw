import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { readRecentSessionUsageFromTranscriptAsync } from "../gateway/session-transcript-usage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  buildStatusMessage,
  configureCliBackend,
  fallbackRoute,
  modelArgs,
  providerModels,
  statusContext,
  type StatusTestArgs,
} from "./status.test-fixtures.js";

const openrouterArgs = {
  ...modelArgs("openrouter", "google/gemini-2.5-pro"),
  thinkingCatalog: [
    { provider: "openrouter", id: "google/gemini-2.5-pro", contextWindow: 999_000 },
    { provider: "google", id: "gemini-2.5-pro", contextWindow: 2_000_000 },
  ],
  config: providerModels(["google", "gemini-2.5-pro", { contextWindow: 2_000_000 }]),
};
function usage(input: number, output: number, cacheRead: number, totalTokens: number) {
  return { input, output, cacheRead, cacheWrite: 0, totalTokens };
}
const freshUsage = (totalTokens: number) => ({
  totalTokens,
  totalTokensFresh: true,
  totalTokensVersion: 1 as const,
});
function transcriptScope(agentId: string, sessionId: string) {
  return {
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:main`,
    storePath: resolveSessionStorePathCore(undefined, { agentId }),
  };
}
beforeEach(() => configureCliBackend());
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
  return withTempHome(
    async () => {
      setRuntimeConfigSnapshot({});
      await run();
    },
    { prefix: "openclaw-status-" },
  ).finally(clearRuntimeConfigSnapshot);
}

describe("status transcript usage and model context", () => {
  function writeTranscriptUsageLog(params: {
    agentId: string;
    sessionId: string;
    model?: string;
    usage?: ReturnType<typeof usage>;
  }) {
    const scope = transcriptScope(params.agentId, params.sessionId);
    replaceSessionEntrySync(scope, { sessionId: params.sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      message: {
        role: "assistant",
        model: params.model ?? "claude-opus-4-6",
        usage: params.usage ?? baselineTranscriptUsage,
      },
    });
  }

  const baselineTranscriptUsage = usage(1, 2, 1000, 1003);

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
      appendTranscriptMessageSync(transcriptScope("worker1", sessionId), {
        message: { role: "assistant", usage: { input: 2_000, output: 20, totalTokens: 2_000 } },
      });
      const updated = await buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:worker1:telegram:12345",
      });
      expect(normalizeTestText(updated)).toContain("Context: 2.0k/32k");
    });
  });

  it.each([
    {
      name: "does not render stale context usage from transcript fallback",
      transcript: usage(3_800_000, 20_000, 0, 3_820_000),
      entry: {
        inputTokens: 3_800_000,
        outputTokens: 20_000,
        totalTokens: 3_800_000,
        totalTokensFresh: false,
      },
      present: ["Context: ?/1.0m"],
      absent: ["Context: 3.8m/1.0m", "Context: 3.82m/1.0m"],
    },
    {
      name: "does not let legacy cumulative session totals override fresh transcript context usage",
      transcript: usage(10_000, 1_000, 26_000, 36_000),
      entry: {
        inputTokens: 16,
        outputTokens: 5_100,
        cacheRead: 2_300_000,
        cacheWrite: 11_000,
        totalTokens: 2_300_000,
      },
      present: ["Cache: 100% hit · 2.3m cached, 11k new", "Context: 36k/1.0m (4%)"],
      absent: ["Context: 2.3m/1.0m"],
    },
  ])("$name", async ({ transcript, entry, present, absent }) => {
    await withStatusHome(async () => {
      const sessionId = "transcript-context";
      writeTranscriptUsageLog({ agentId: "main", sessionId, usage: transcript });
      const text = normalizeTestText(
        await buildTranscriptUsageStatusMessage({
          sessionEntry: { sessionId, contextTokens: 1_000_000, ...entry },
        }),
      );
      present.forEach((snippet) => expect(text).toContain(snippet));
      absent.forEach((snippet) => expect(text).not.toContain(snippet));
    });
  });

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withStatusHome(async () => {
      const sessionId = "sess-cache-delivery-mirror";
      writeTranscriptUsageLog({ agentId: "main", sessionId });
      appendTranscriptMessageSync(transcriptScope("main", sessionId), {
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          usage: usage(0, 0, 0, 0),
        },
      });

      const text = await buildTranscriptStatusText({
        sessionId,
        sessionKey: "agent:main:main",
      });

      expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
    });
  });

  it.each([
    ["slash", "google/gemini-2.5-pro", openrouterArgs, "999k", "2.0m"],
    [
      "bare",
      "gemini-2.5-pro",
      {
        ...modelArgs("google-gemini-cli", "gemini-2.5-pro"),
        thinkingCatalog: [
          { provider: "google-gemini-cli", id: "gemini-2.5-pro", contextWindow: 1_000_000 },
          { provider: "google", id: "gemini-2.5-pro", contextWindow: 128_000 },
        ],
      },
      "1.0m",
      "128k",
    ],
  ] as const)(
    "keeps transcript-derived %s model ids in their admitted provider catalog",
    async (_kind, model, args, context, otherContext) => {
      await withStatusHome(async () => {
        const sessionId = "catalog-context";
        writeTranscriptUsageLog({
          agentId: "main",
          sessionId,
          model,
          usage: usage(2, 3, 1200, 1205),
        });
        const normalized = normalizeTestText(
          await buildTranscriptUsageStatusMessage({
            ...args,
            thinkingCatalog: [...args.thinkingCatalog],
            sessionEntry: { sessionId, totalTokens: 5 },
          }),
        );
        expect(normalized).toContain(`Context: 1.2k/${context}`);
        expect(normalized).not.toContain(`Context: 1.2k/${otherContext}`);
      });
    },
  );

  it("keeps runtime slash model ids in their admitted provider catalog when modelProvider is missing", () => {
    const text = buildStatusMessage({
      ...openrouterArgs,
      sessionEntry: {
        ...freshUsage(1205),
        model: "google/gemini-2.5-pro",
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    const route = fallbackRoute(
      { provider: "xiaomi", model: "mimo-v2-flash" },
      { provider: "fake-minimax", model: "FakeMiniMax-M2.5" },
    );
    const text = buildStatusMessage({
      ...route,
      config: providerModels(
        ["fake-minimax", "FakeMiniMax-M2.5", { contextWindow: 777_000 }],
        ["xiaomi", "mimo-v2-flash", { contextWindow: 1_048_576 }],
      ),
      sessionEntry: {
        ...route.sessionEntry,
        modelProvider: undefined,
        model: "fake-minimax/FakeMiniMax-M2.5",
        ...freshUsage(49_000),
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
      config: providerModels(["openai", "gpt-4o", { contextWindow: 777_000 }]),
      sessionEntry: {
        model: "openai/gpt-4o",
        ...freshUsage(49_000),
      },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
  });
});
