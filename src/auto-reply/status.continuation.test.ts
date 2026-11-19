// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/** Tests the RFC §6.3 /status continuation row. Harness mirrored from status.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { getContextWindowCaches } from "../agents/context-cache.js";
import type { OpenClawConfig } from "../config/config.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import {
  buildStatusMessage as buildStatusMessageRaw,
  type buildStatusMessage as BuildStatusMessage,
  statusModelRefs,
} from "../status/status-message.test-support.js";

const buildStatusMessage: typeof BuildStatusMessage = (args) =>
  buildStatusMessageRaw({
    modelAuth: "api-key",
    activeModelAuth: "api-key",
    ...args,
  });

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn(
    (): Array<{ name: string; description: string; pluginId: string }> => [],
  ),
}));

// mock-isolation: Plugin commands come from the test; the real list reads the active plugin registry.
vi.mock("../plugins/commands.js", () => ({
  listPluginCommands,
}));

// Continuation counters — mocked so the /status renderer sees session-keyed
// non-zero values in the "full row" regression test below. Defaults to 0
// for every session so every other test's behavior is unchanged.
const continuationMocks = vi.hoisted(() => ({
  pending: new Map<string, number>(),
  staged: new Map<string, number>(),
  volitional: new Map<string, number>(),
}));

vi.mock("./continuation/delegate-store.js", async () => {
  const actual = await vi.importActual<typeof import("./continuation/delegate-store.js")>(
    "./continuation/delegate-store.js",
  );
  return {
    ...actual,
    pendingDelegateCount: (sessionKey: string): number =>
      continuationMocks.pending.get(sessionKey) ?? 0,
  };
});

vi.mock("./continuation/delegate-store-post-compaction.js", async () => {
  const actual = await vi.importActual<
    typeof import("./continuation/delegate-store-post-compaction.js")
  >("./continuation/delegate-store-post-compaction.js");
  return {
    ...actual,
    stagedPostCompactionDelegateCount: (sessionKey: string): number =>
      continuationMocks.staged.get(sessionKey) ?? 0,
  };
});

vi.mock("../agents/tools/request-compaction-tool.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/tools/request-compaction-tool.js")>(
    "../agents/tools/request-compaction-tool.js",
  );
  return {
    ...actual,
    getVolitionalCompactionCount: (sessionKey: string): number =>
      continuationMocks.volitional.get(sessionKey) ?? 0,
  };
});

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
  listPluginCommands.mockReset();
  listPluginCommands.mockImplementation(() => []);
  getContextWindowCaches().discoveredTokenCache.clear();
});

describe("buildStatusMessage", () => {
  it("summarizes agent readiness and context usage", () => {
    // Session age and last update render relative to now: 4 hours after epoch.
    vi.useFakeTimers({ toFake: ["Date"], now: 4 * 60 * 60_000 });
    const text = buildStatusMessage({
      modelRefs: statusModelRefs({ provider: "anthropic", model: "test:opus" }),
      config: {
        models: {
          providers: {
            anthropic: {
              apiKey: "test-key",
              models: [
                {
                  id: "test:opus",
                  contextTokens: 32_000,
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "anthropic/test:opus",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        sessionStartedAt: 1 * 60 * 60_000 + 46 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 16_000,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        contextTokens: 32_000,
        thinkingLevel: "low",
        verboseLevel: "on",
        compactionCount: 2,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "medium",
      resolvedVerbose: "off",
      resolvedHarness: "openclaw",
      queue: { mode: "collect", depth: 0 },
      pluginHealthLine: "🔌 Plugins: OK",
      subagentsLine: "🤖 Subagents: 1\n- active run",
      // The caller prepares the estimate (upstream #197599): 1.2k in + 800 out at $1/M.
      estimatedCostUsd: 0.002,
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("OpenClaw");
    expect(normalized).toContain("Model: anthropic/test:opus");
    expect(normalized).toContain("api-key");
    expect(normalized).toContain("Plugins: OK");
    expect(normalized).toContain("Tokens: 1.2k in / 800 out");
    expect(normalized).toContain("Cost: $0.0020");
    expect(normalized).toContain("Context: 16k/32k (50%)");
    expect(normalized).toContain("Compactions: 2");
    expect(normalized).toContain("Session: agent:main:main");
    expect(normalized).toContain("duration 2h 14m");
    expect(normalized).toContain("updated 4h ago");
    expect(normalized).toContain("Execution: direct");
    expect(normalized).toContain("Runtime: OpenClaw Default");
    expect(normalized).not.toContain("Runner:");
    expect(normalized).toContain("think medium");
    expect(normalized).not.toContain("verbose");
    expect(normalized).toContain("elevated");
    expect(normalized).toContain("Queue: collect");
    // RFC §6.3 — with continuation disabled (default), the row is absent.
    expect(normalized).not.toContain("Continuation:");
    expect(normalized).toContain("- active run");
  });

  it("renders the RFC §6.3 continuation row when enabled and chain depth > 0", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            continuation: {
              enabled: true,
              maxChainLength: 10,
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: { model: "anthropic/pi:opus" },
      modelRefs: statusModelRefs({ provider: "anthropic", model: "pi:opus" }),
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 32_000,
        continuationChainCount: 3,
      },
      sessionKey: "agent:main:test-187",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);
    // Shape comes from docs/design/continue-work-signal-v2.md §6.3.
    expect(normalized).toMatch(/Continuation: chain 3\/10/);
  });

  it("renders the full RFC §6.3 continuation row with all four fields", () => {
    const key = "agent:main:test-187-full-row";
    continuationMocks.pending.set(key, 2);
    continuationMocks.staged.set(key, 1);
    continuationMocks.volitional.set(key, 3);
    try {
      const text = buildStatusMessage({
        config: {
          agents: {
            defaults: {
              continuation: { enabled: true, maxChainLength: 10 },
            },
          },
        } as unknown as OpenClawConfig,
        agent: { model: "anthropic/pi:opus" },
        modelRefs: statusModelRefs({ provider: "anthropic", model: "pi:opus" }),
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 32_000,
          continuationChainCount: 4,
        },
        sessionKey: key,
        sessionScope: "per-sender",
        queue: { mode: "collect", depth: 0 },
      });
      const normalized = normalizeTestText(text);
      // All four RFC §6.3 fields must render, pipe-joined, in order.
      expect(normalized).toMatch(
        /Continuation: chain 4\/10 \| 2 delegates pending \| 1 post-compaction staged \| volitional: 3/,
      );
    } finally {
      continuationMocks.pending.delete(key);
      continuationMocks.staged.delete(key);
      continuationMocks.volitional.delete(key);
    }
  });

  it("renders a partial continuation row showing only the non-zero fields", () => {
    const key = "agent:main:test-187-partial";
    // chain + staged only; pending=0 and volitional=0 must be omitted from the line.
    continuationMocks.staged.set(key, 1);
    try {
      const text = buildStatusMessage({
        config: {
          agents: {
            defaults: {
              continuation: { enabled: true, maxChainLength: 10 },
            },
          },
        } as unknown as OpenClawConfig,
        agent: { model: "anthropic/pi:opus" },
        modelRefs: statusModelRefs({ provider: "anthropic", model: "pi:opus" }),
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 32_000,
          continuationChainCount: 2,
        },
        sessionKey: key,
        sessionScope: "per-sender",
        queue: { mode: "collect", depth: 0 },
      });
      const normalized = normalizeTestText(text);
      // Chain + staged visible; pending / volitional fields omitted entirely.
      expect(normalized).toMatch(/Continuation: chain 2\/10 \| 1 post-compaction staged$/m);
      expect(normalized).not.toContain("delegate");
      expect(normalized).not.toContain("volitional");
    } finally {
      continuationMocks.staged.delete(key);
    }
  });

  it("renders singular 'delegate' when pending count is 1 (plural boundary)", () => {
    const key = "agent:main:test-187-singular";
    continuationMocks.pending.set(key, 1);
    try {
      const text = buildStatusMessage({
        config: {
          agents: {
            defaults: {
              continuation: { enabled: true, maxChainLength: 10 },
            },
          },
        } as unknown as OpenClawConfig,
        agent: { model: "anthropic/pi:opus" },
        modelRefs: statusModelRefs({ provider: "anthropic", model: "pi:opus" }),
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 32_000,
          continuationChainCount: 1,
        },
        sessionKey: key,
        sessionScope: "per-sender",
        queue: { mode: "collect", depth: 0 },
      });
      const normalized = normalizeTestText(text);
      expect(normalized).toMatch(/Continuation: chain 1\/10 \| 1 delegate pending$/m);
      expect(normalized).not.toMatch(/1 delegates pending/);
    } finally {
      continuationMocks.pending.delete(key);
    }
  });

  it("omits the continuation row when enabled but every field is zero", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            continuation: {
              enabled: true,
              maxChainLength: 10,
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: { model: "anthropic/pi:opus" },
      modelRefs: statusModelRefs({ provider: "anthropic", model: "pi:opus" }),
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 32_000,
        continuationChainCount: 0,
      },
      sessionKey: "agent:main:test-187-empty",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Continuation:");
  });
});
