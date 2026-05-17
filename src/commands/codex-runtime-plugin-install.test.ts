import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const loadInstalledPluginIndexInstallRecords = vi.hoisted(() => vi.fn());
const ensureOnboardingPluginInstalled = vi.hoisted(() => vi.fn());
const existsSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => existsSync(...args),
  };
});

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: (params: unknown) =>
    loadInstalledPluginIndexInstallRecords(params),
}));

vi.mock("./onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: (params: unknown) => ensureOnboardingPluginInstalled(params),
}));

function createLog() {
  const messages: string[] = [];
  return {
    log: (message: string) => {
      messages.push(message);
    },
    messages,
  };
}

describe("ensureCodexRuntimePluginForGatewayStartup", () => {
  beforeEach(() => {
    loadInstalledPluginIndexInstallRecords.mockReset();
    ensureOnboardingPluginInstalled.mockReset();
    existsSync.mockReset();
  });

  it("returns both configs unchanged when no openai models are configured", async () => {
    const cfg: OpenClawConfig = { gateway: { auth: { mode: "token" } } } as OpenClawConfig;
    const activationSourceConfig: OpenClawConfig = { plugins: { allow: ["telegram"] } };
    const log = createLog();

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({
      cfg,
      activationSourceConfig,
      log: log.log,
    });

    expect(result.cfg).toBe(cfg);
    expect(result.activationSourceConfig).toBe(activationSourceConfig);
    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(log.messages).toEqual([]);
  });

  it("enables codex in both runtime and activation source configs when openai models are present and plugin is already installed", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as OpenClawConfig;
    const activationSourceConfig: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as OpenClawConfig;
    const log = createLog();

    loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { installPath: "/installed/codex" },
    });
    existsSync.mockReturnValue(true);

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({
      cfg,
      activationSourceConfig,
      log: log.log,
    });

    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.activationSourceConfig?.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("installs codex when missing on disk and enables it in both configs", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as OpenClawConfig;
    const activationSourceConfig: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as OpenClawConfig;
    const log = createLog();

    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    existsSync.mockReturnValue(false);
    ensureOnboardingPluginInstalled.mockImplementation(async (params: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          entries: {
            ...params.cfg.plugins?.entries,
            codex: { enabled: true },
          },
        },
      },
      installed: true,
      status: "completed",
    }));

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({
      cfg,
      activationSourceConfig,
      log: log.log,
    });

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledTimes(1);
    const installArgs = ensureOnboardingPluginInstalled.mock.calls[0]?.[0] as {
      prompter: { progress: (label: string) => { update: (m: string) => void; stop: () => void } };
    };
    // P1 regression guard: the startup prompter must support progress() as a no-op,
    // because the npm install path always invokes prompter.progress(...) before
    // downloading. Throwing here would abort the exact install path this helper
    // is supposed to enable.
    const handle = installArgs.prompter.progress("Installing codex");
    expect(() => handle.update("downloading")).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.activationSourceConfig?.plugins?.entries?.codex?.enabled).toBe(true);
    expect(log.messages.some((m) => m.includes("installing @openclaw/codex"))).toBe(true);
  });

  it("adds codex to plugins.allow in both configs when allowlist excludes it and logs a notice", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      plugins: { allow: ["telegram"] },
    } as OpenClawConfig;
    const activationSourceConfig: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      plugins: { allow: ["telegram"] },
    } as OpenClawConfig;
    const log = createLog();

    loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { installPath: "/installed/codex" },
    });
    existsSync.mockReturnValue(true);

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({
      cfg,
      activationSourceConfig,
      log: log.log,
    });

    expect(result.cfg.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(result.activationSourceConfig?.plugins?.allow).toEqual(["telegram", "codex"]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.activationSourceConfig?.plugins?.entries?.codex?.enabled).toBe(true);
    expect(
      log.messages.some((m) => m.includes("adding") && m.includes("codex") && m.includes("allow")),
    ).toBe(true);
  });

  it("does not override plugins.deny and logs a clear actionable warning", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      plugins: { deny: ["codex"] },
    } as OpenClawConfig;
    const log = createLog();

    loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { installPath: "/installed/codex" },
    });
    existsSync.mockReturnValue(true);

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({ cfg, log: log.log });

    expect(result.cfg.plugins?.deny).toEqual(["codex"]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBeUndefined();
    expect(log.messages.some((m) => m.includes("plugins.deny"))).toBe(true);
  });

  it("does not enable codex and logs a warning when plugins are globally disabled", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      plugins: { enabled: false },
    } as OpenClawConfig;
    const log = createLog();

    loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { installPath: "/installed/codex" },
    });
    existsSync.mockReturnValue(true);

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({ cfg, log: log.log });

    expect(result.cfg.plugins?.entries?.codex?.enabled).toBeUndefined();
    expect(log.messages.some((m) => m.includes("plugins.enabled"))).toBe(true);
  });

  it("does not invoke any install side effect when plugins.deny blocks codex and the package is missing", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      plugins: { deny: ["codex"] },
    } as OpenClawConfig;
    const log = createLog();

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({ cfg, log: log.log });

    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(result.cfg).toBe(cfg);
    expect(log.messages.some((m) => m.includes("skipping startup install"))).toBe(true);
    expect(log.messages.some((m) => m.includes("openclaw plugins install"))).toBe(true);
  });

  it("does not invoke any install side effect when plugins.enabled is false and the package is missing", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      plugins: { enabled: false },
    } as OpenClawConfig;
    const log = createLog();

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    const result = await ensureCodexRuntimePluginForGatewayStartup({ cfg, log: log.log });

    expect(loadInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(result.cfg).toBe(cfg);
    expect(log.messages.some((m) => m.includes("skipping startup install"))).toBe(true);
    expect(log.messages.some((m) => m.includes("openclaw plugins install"))).toBe(true);
  });

  it("returns passthrough with manual fix log when install times out", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } as OpenClawConfig;
    const log = createLog();

    loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    existsSync.mockReturnValue(false);
    ensureOnboardingPluginInstalled.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    const { ensureCodexRuntimePluginForGatewayStartup } =
      await import("./codex-runtime-plugin-install.js");
    // Inject a 0ms timeout so the test doesn't wait 60s
    const result = await ensureCodexRuntimePluginForGatewayStartup({
      cfg,
      log: log.log,
      installTimeoutMs: 0,
    });

    expect(result.cfg).toBe(cfg);
    expect(log.messages.some((m) => m.includes("timed out"))).toBe(true);
    expect(log.messages.some((m) => m.includes("openclaw plugins install"))).toBe(true);
  });
});
