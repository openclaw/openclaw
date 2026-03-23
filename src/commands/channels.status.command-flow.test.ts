import { beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn();
const resolveCommandSecretRefsViaGateway = vi.fn();
const requireValidConfigSnapshot = vi.fn();
const listChannelPlugins = vi.fn();
const withProgress = vi.fn(async (_opts: unknown, run: () => Promise<unknown>) => await run());

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (opts: unknown) => resolveCommandSecretRefsViaGateway(opts),
}));

vi.mock("./shared.js", () => ({
  requireValidConfigSnapshot: (runtime: unknown) => requireValidConfigSnapshot(runtime),
  formatChannelAccountLabel: ({
    channel,
    accountId,
  }: {
    channel: string;
    accountId: string;
    name?: string;
  }) => `${channel} ${accountId}`,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => listChannelPlugins(),
  getChannelPlugin: (channel: string) =>
    (listChannelPlugins() as Array<{ id: string }>).find((plugin) => plugin.id === channel),
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: (opts: unknown, run: () => Promise<unknown>) => withProgress(opts, run),
}));

const { channelsStatusCommand } = await import("./channels/status.js");

function createTokenOnlyPlugin() {
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/channels/discord",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      defaultAccountId: () => "default",
      inspectAccount: (cfg: { secretResolved?: boolean }) =>
        cfg.secretResolved
          ? {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "resolved-discord-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
      resolveAccount: (cfg: { secretResolved?: boolean }) =>
        cfg.secretResolved
          ? {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "resolved-discord-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : {
              name: "Primary",
              enabled: true,
              configured: true,
              token: "",
              tokenSource: "config",
              tokenStatus: "configured_unavailable",
            },
      isConfigured: () => true,
      isEnabled: () => true,
    },
    actions: {
      listActions: () => ["send"],
    },
  };
}

function createRuntimeCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => errors.push(String(message)),
    exit: (_code?: number) => undefined,
  };
  return { runtime, logs, errors };
}

describe("channelsStatusCommand SecretRef fallback flow", () => {
  beforeEach(() => {
    callGateway.mockReset();
    resolveCommandSecretRefsViaGateway.mockReset();
    requireValidConfigSnapshot.mockReset();
    listChannelPlugins.mockReset();
    withProgress.mockClear();
    listChannelPlugins.mockReturnValue([createTokenOnlyPlugin()]);
  });

  it("keeps read-only fallback output when SecretRefs are unresolved", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed"));
    requireValidConfigSnapshot.mockResolvedValue({ secretResolved: false, channels: {} });
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { secretResolved: false, channels: {} },
      diagnostics: [
        "channels status: channels.discord.token is unavailable in this command path; continuing with degraded read-only config.",
      ],
      targetStatesByPath: {},
      hadUnresolvedTargets: true,
    });
    const { runtime, logs, errors } = createRuntimeCapture();

    await channelsStatusCommand({ probe: false }, runtime as never);

    expect(errors.some((line) => line.includes("Gateway not reachable"))).toBe(true);
    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: "channels status",
        mode: "read_only_status",
      }),
    );
    expect(
      logs.some((line) =>
        line.includes("[secrets] channels status: channels.discord.token is unavailable"),
      ),
    ).toBe(true);
    const joined = logs.join("\n");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("prefers resolved snapshots when command-local SecretRef resolution succeeds", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed"));
    requireValidConfigSnapshot.mockResolvedValue({ secretResolved: false, channels: {} });
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { secretResolved: true, channels: {} },
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    const { runtime, logs } = createRuntimeCapture();

    await channelsStatusCommand({ probe: false }, runtime as never);

    const joined = logs.join("\n");
    expect(joined).toContain("configured");
    expect(joined).toContain("token:config");
    expect(joined).not.toContain("secret unavailable in this command path");
    expect(joined).not.toContain("token:config (unavailable)");
  });

  it("uses a larger default timeout for probe mode", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      channelOrder: [],
      channelLabels: {},
      channelDetailLabels: {},
      channelSystemImages: {},
      channelMeta: [],
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    const { runtime } = createRuntimeCapture();

    await channelsStatusCommand({ probe: true }, runtime as never);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "channels.status",
        params: expect.objectContaining({
          probe: true,
          timeoutMs: 20_000,
        }),
        timeoutMs: 20_000,
      }),
    );
  });
});
