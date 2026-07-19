import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of [
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.filter(
      (modelMigration) => modelMigration.id === "defaultModel->agents.defaults.model",
    ),
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
  ]) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

function configWithPath(path: string): Record<string, unknown> {
  return path
    .split(".")
    .reduceRight<unknown>(
      (value, segment) => (segment === "0" ? [value] : { [segment]: value }),
      1,
    ) as Record<string, unknown>;
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (Array.isArray(current)) {
      return current[Number(segment)];
    }
    return current && typeof current === "object"
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, value);
}

describe("retired runtime config migrations", () => {
  it("consolidates modality model lists with capability tags and exact deduplication", () => {
    const result = applyAll({
      tools: {
        media: {
          models: [{ provider: "openai", model: "shared", capabilities: ["image"] }],
          image: {
            enabled: true,
            models: [{ provider: "openai", model: "shared" }],
          },
          audio: {
            timeoutSeconds: 20,
            models: [
              { provider: "deepgram", model: "nova-3" },
              { provider: "deepgram", model: "nova-3" },
              { provider: "local", model: "same", timeoutSeconds: 20 },
            ],
          },
          video: { models: [{ provider: "local", model: "same", timeoutSeconds: 20 }] },
        },
      },
    });

    expect(result.raw).toEqual({
      tools: {
        media: {
          models: [
            { provider: "openai", model: "shared", capabilities: ["image"] },
            {
              provider: "deepgram",
              model: "nova-3",
              capabilities: ["audio"],
            },
            {
              provider: "local",
              model: "same",
              timeoutSeconds: 20,
              capabilities: ["audio"],
            },
            {
              provider: "local",
              model: "same",
              timeoutSeconds: 20,
              capabilities: ["video"],
            },
            { provider: "openai", model: "shared", capabilities: ["image"] },
          ],
          image: { enabled: true },
          audio: { timeoutSeconds: 20 },
        },
      },
    });
  });

  it("keeps modality defaults for auto-detection and preserves distinct legacy entries", () => {
    const result = applyAll({
      tools: {
        media: {
          models: [
            { provider: "openai", model: "shared", capabilities: ["image", "audio"] },
            { provider: "fallback", capabilities: ["audio"] },
          ],
          image: {
            timeoutSeconds: 180,
            models: [{ provider: "openai", model: "shared", prompt: "Describe details" }],
          },
          audio: {
            language: "en",
            models: [{ provider: "local-default" }],
          },
        },
      },
    });

    expect(getPath(result.raw, "tools.media.models")).toEqual([
      {
        provider: "openai",
        model: "shared",
        prompt: "Describe details",
        capabilities: ["image"],
      },
      { provider: "local-default", capabilities: ["audio"] },
      { provider: "openai", model: "shared", capabilities: ["image", "audio"] },
      { provider: "fallback", capabilities: ["audio"] },
    ]);
    expect(getPath(result.raw, "tools.media.image.timeoutSeconds")).toBe(180);
    expect(getPath(result.raw, "tools.media.audio.language")).toBe("en");
  });

  it("preserves independent fallback order across capability lists", () => {
    const result = applyAll({
      tools: {
        media: {
          image: { models: ["a", "b", "c"].map((model) => ({ provider: "p", model })) },
          audio: { models: ["c", "b", "a"].map((model) => ({ provider: "p", model })) },
        },
      },
    });
    const models = getPath(result.raw, "tools.media.models") as Array<{
      model: string;
      capabilities: string[];
    }>;
    expect(
      models.filter((model) => model.capabilities.includes("image")).map((model) => model.model),
    ).toEqual(["a", "b", "c"]);
    expect(
      models.filter((model) => model.capabilities.includes("audio")).map((model) => model.model),
    ).toEqual(["c", "b", "a"]);
  });

  it("preserves explicit legacy capability filtering", () => {
    const result = applyAll({
      tools: {
        media: {
          image: {
            models: [
              { provider: "skip", model: "audio-only", capabilities: ["audio"] },
              {
                provider: "keep",
                model: "image-first",
                capabilities: ["image", "audio"],
              },
            ],
          },
        },
      },
    });

    expect(getPath(result.raw, "tools.media.models")).toEqual([
      { provider: "keep", model: "image-first", capabilities: ["image"] },
    ]);
    expect(getPath(result.raw, "tools.media.image.preferredModel")).toBeUndefined();
  });
  it.each([
    "systemAgent",
    "marketplaces",
    "cli.banner.taglineMode",
    "commitments",
    "auth.cooldowns",
    "secrets.resolution",
    "browser.remoteCdpTimeoutMs",
    "browser.tabCleanup.idleMinutes",
    "tools.loopDetection.warningThreshold",
    "tools.loopDetection.detectors",
    "agents.defaults.compaction.reserveTokens",
    "agents.defaults.compaction.reserveTokensFloor",
    "agents.defaults.compaction.maxHistoryShare",
    "agents.defaults.contextPruning.softTrim",
    "memory.search.chunking",
    "memory.search.sync.watchDebounceMs",
    "memory.search.sync.intervalMinutes",
    "memory.search.query.hybrid.vectorWeight",
    "memory.search.query.hybrid.mmr.lambda",
    "memory.search.query.hybrid.temporalDecay.halfLifeDays",
    "memory.search.cache.maxEntries",
    "agents.defaults.cliBackends.codex.reliability.outputLimits",
    "agents.defaults.cliBackends.codex.reliability.watchdog.fresh.noOutputTimeoutMs",
    "agents.defaults.runRetries",
    "agents.list.0.compaction.reserveTokens",
    "agents.list.0.contextPruning.softTrimRatio",
    "agents.list.0.memory.search.chunking",
    "agents.list.0.cliBackends.codex.reliability.outputLimits",
    "agents.list.0.runRetries",
    "agents.list.0.tools.loopDetection.warningThreshold",
    "agents.list.0.tools.loopDetection.detectors",
    "gateway.handshakeTimeoutMs",
    "gateway.channelHealthCheckMinutes",
    "gateway.reload.debounceMs",
    "gateway.reload.deferralTimeoutMs",
    "gateway.http.endpoints.chatCompletions.maxBodyBytes",
    "gateway.http.endpoints.responses.maxBodyBytes",
    "session.typingIntervalSeconds",
    "session.writeLock",
    "session.agentToAgent.maxPingPongTurns",
    "cron.maxConcurrentRuns",
    "cron.triggers.minIntervalMs",
    "cron.retry",
    "diagnostics.stuckSessionWarnMs",
    "diagnostics.memoryPressureSnapshot",
    "diagnostics.memoryPressureBundle",
    "web.heartbeatSeconds",
    "web.reconnect",
    "web.whatsapp",
    "messages.queue.debounceMs",
    "messages.statusReactions.timing",
    "acp.stream.coalesceIdleMs",
    "acp.stream.hiddenBoundarySeparator",
    "acp.maxConcurrentSessions",
    "acp.runtime.ttlMinutes",
    "mcp.sessionIdleTtlMs",
    "worktrees",
    "transcripts.maxUtterances",
    "hooks.maxBodyBytes",
    "update.auto.stableDelayHours",
  ] as const)("strips retired tuning knob %s", (path) => {
    const result = applyAll(configWithPath(path));
    expect(getPath(result.raw, path)).toBeUndefined();
    expect(result.changes).toContain(
      "Removed retired runtime tuning knobs; built-in defaults now apply.",
    );
  });

  it("moves aliases and strips dead keys", () => {
    const result = applyAll({
      tui: { footer: { showRemoteHost: true } },
      defaultModel: "openai/gpt-5.6",
      commands: { modelsWrite: true },
      messages: { messagePrefix: "[wa]" },
      cron: { webhook: "https://example.com", webhookToken: "keep" },
      session: { maintenance: { pruneDays: 7 }, resetByType: { dm: { mode: "idle" } } },
      talk: { realtime: { voice: "alloy" } },
      mcp: { servers: { docs: { connectTimeout: 2, timeout: 3 } } },
      nodeHost: { mcp: { servers: { local: { connect_timeout: 4 } } } },
      tools: {
        media: {
          asyncCompletion: { directSend: true },
          audio: { deepgram: { smartFormat: true } },
        },
        message: { allowCrossContextSend: true },
      },
    });

    expect(result.raw).toMatchObject({
      channels: { whatsapp: { messagePrefix: "[wa]" } },
      agents: { defaults: { model: "openai/gpt-5.6" } },
      cron: { webhookToken: "keep" },
      session: { maintenance: { pruneAfter: 7 }, resetByType: { direct: { mode: "idle" } } },
      talk: { realtime: { speakerVoice: "alloy" } },
      mcp: { servers: { docs: { connectionTimeoutMs: 2000, requestTimeoutMs: 3000 } } },
      nodeHost: { mcp: { servers: { local: { connectionTimeoutMs: 4000 } } } },
      tools: {
        media: {},
        message: { crossContext: { allowWithinProvider: true, allowAcrossProviders: true } },
      },
    });
    expect(result.raw).not.toHaveProperty("tui");
    expect(result.raw).not.toHaveProperty("commands.modelsWrite");
    expect(result.changes.length).toBeGreaterThan(8);
  });
});
