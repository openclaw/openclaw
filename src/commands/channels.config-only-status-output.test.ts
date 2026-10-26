// Channels config-only status tests cover fallback output when gateway status is unavailable.
import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";
import { channelsStatusCommand } from "./channels/status.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const activeChannelPlugins = vi.hoisted(() => [] as ChannelPlugin[]);
const listReadOnlyChannelPluginsForConfig = vi.hoisted(() => vi.fn(() => activeChannelPlugins));
const fallback = vi.hoisted(() => ({ config: vi.fn(), resolved: vi.fn() }));

// mock-isolation: Exercise the real command fallback with an unavailable synthetic Gateway.
vi.mock("../gateway/call.js", () => ({
  callGateway: async () => {
    throw new Error("fixture gateway closed");
  },
}));
// mock-isolation: Gateway readiness is an external process fact, not part of config-only rendering.
vi.mock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
  waitForGatewayDiagnosticReadiness: vi.fn(async () => undefined),
}));
// mock-isolation: Supply fixture-owned authored and resolved snapshots without operator config reads.
vi.mock("./config-validation.js", () => ({ requireValidConfigFileSnapshot: fallback.config }));
// mock-isolation: Keep secret resolution at the command boundary; account projection stays real.
vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: fallback.resolved,
}));
// mock-isolation: Synthetic channel descriptors do not have persisted secret targets.
vi.mock("../cli/command-secret-targets.js", () => ({
  getConfiguredChannelsCommandSecretTargetIds: () => [],
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => activeChannelPlugins,
  getLoadedChannelPlugin: (id: string) => activeChannelPlugins.find((plugin) => plugin.id === id),
  getChannelPlugin: (id: string) => activeChannelPlugins.find((plugin) => plugin.id === id),
  normalizeChannelId: (value: string) => {
    const normalized = value.trim().toLowerCase();
    return normalized === "wa" || normalized === "whatsapp" ? "whatsapp" : null;
  },
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig,
}));

function registerPlugins(...plugins: ChannelPlugin[]) {
  activeChannelPlugins.splice(0, activeChannelPlugins.length, ...plugins);
}

async function formatLocalStatusSummary(
  cfg: OpenClawConfig & { secretResolved?: boolean },
  options?: {
    sourceConfig?: OpenClawConfig;
    channel?: string;
  },
) {
  fallback.config.mockResolvedValue({
    path: "/fixture/openclaw.json",
    config: options?.sourceConfig ?? cfg,
  });
  fallback.resolved.mockResolvedValue({
    resolvedConfig: cfg,
    effectiveConfig: cfg,
    diagnostics: [],
  });
  const { runtime, logs } = createCapturingTestRuntime();
  await channelsStatusCommand({ channel: options?.channel }, runtime);
  return logs.join("\n");
}

function unresolvedTokenAccount() {
  return {
    name: "Primary",
    enabled: true,
    configured: true,
    token: "",
    tokenSource: "config",
    tokenStatus: "configured_unavailable",
  } as const;
}

function makeTokenPlugin(
  config: Partial<ChannelPlugin["config"]> = {},
  id = "token-only",
  label = "TokenOnly",
): ChannelPlugin {
  return makeDirectPlugin({
    id,
    label,
    docsPath: `/channels/${id}`,
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      isConfigured: () => true,
      isEnabled: () => true,
      resolveAccount: () => unresolvedTokenAccount(),
      ...config,
    },
  });
}

function expectResolvedTokenStatusSummary(summary: string) {
  expect(summary).toContain("TokenOnly");
  expect(summary).toContain("configured");
  expect(summary).toContain("token:config");
  expect(summary).not.toContain("secret unavailable in this command path");
}

describe("config-only channels status output", () => {
  it("preserves exact config-only status filtering for external channels", async () => {
    registerPlugins(makeTokenPlugin(), makeTokenPlugin({}, "whatsapp", "WhatsApp"));
    const summary = await formatLocalStatusSummary(
      { channels: { "token-only": {}, whatsapp: {} } },
      { channel: "TOKEN-ONLY" },
    );
    expect(summary).toContain("Gateway not reachable; showing config-only status.");
    expect(summary).toContain("TokenOnly");
    expect(summary).not.toContain("WhatsApp");
  });

  it("does not resolve raw source config for extension channels without inspectAccount", async () => {
    registerPlugins(
      makeTokenPlugin({
        resolveAccount: (cfg) => {
          if (!(cfg as { secretResolved?: boolean }).secretResolved) {
            throw new Error("raw SecretRef reached resolveAccount");
          }
          return { ...unresolvedTokenAccount(), token: "resolved-token", tokenStatus: "available" };
        },
      }),
    );

    const joined = await formatLocalStatusSummary(
      { secretResolved: true, channels: {} },
      { sourceConfig: { channels: {} } },
    );
    expectResolvedTokenStatusSummary(joined);
  });

  it("prefers resolved config snapshots when command-local secret resolution succeeds", async () => {
    registerPlugins(
      makeTokenPlugin({
        inspectAccount: (cfg) => ({
          accountId: "primary",
          ...unresolvedTokenAccount(),
          ...((cfg as { secretResolved?: boolean }).secretResolved
            ? { token: "resolved-token", tokenStatus: "available" }
            : {}),
        }),
      }),
    );

    const joined = await formatLocalStatusSummary(
      { secretResolved: true, channels: {} },
      { sourceConfig: { channels: {} } },
    );
    expectResolvedTokenStatusSummary(joined);
    expect(joined).not.toContain("token:config (unavailable)");
  });
});
