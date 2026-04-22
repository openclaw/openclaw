import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for issue #69960: `runPluginInstallCommand` must compute the
 * profile-aware extensions dir at the CLI layer and forward it into
 * `installPluginFromNpmSpec` / `installPluginFromPath`. Without this, the
 * downstream fallback in `install.ts` resolves a stale module-level
 * `CONFIG_DIR`, so `--profile <name>` (which sets `OPENCLAW_STATE_DIR`) had no
 * effect on where the plugin was written.
 */

type InstallPluginResult = { ok: false; code: string; error: string };

const hoisted = vi.hoisted(() => {
  const installFromNpmMock = vi.fn<(args: Record<string, unknown>) => Promise<InstallPluginResult>>(
    async () => ({ ok: false, code: "mock", error: "mock" }),
  );
  const installFromPathMock = vi.fn<
    (args: Record<string, unknown>) => Promise<InstallPluginResult>
  >(async () => ({ ok: false, code: "mock", error: "mock" }));
  return { installFromNpmMock, installFromPathMock };
});

vi.mock("../plugins/install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {},
  installPluginFromNpmSpec: hoisted.installFromNpmMock,
  installPluginFromPath: hoisted.installFromPathMock,
}));

vi.mock("./plugins-command-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("./plugins-command-helpers.js")>(
    "./plugins-command-helpers.js",
  );
  return {
    ...actual,
    // Force the preferred-clawhub branch to be skipped so we reach the npm call.
    buildPreferredClawHubSpec: vi.fn(() => null),
  };
});

vi.mock("../infra/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub.js")>("../infra/clawhub.js");
  return {
    ...actual,
    parseClawHubPluginSpec: vi.fn(() => null),
  };
});

vi.mock("../plugins/clawhub.js", async () => {
  const actual =
    await vi.importActual<typeof import("../plugins/clawhub.js")>("../plugins/clawhub.js");
  return {
    ...actual,
    // Force the clawhub branch to fall through to the npm path.
    installPluginFromClawHub: vi.fn(async () => ({
      ok: false,
      code: "clawhub-miss",
      error: "not a clawhub spec",
    })),
  };
});

vi.mock("../plugins/marketplace.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/marketplace.js")>(
    "../plugins/marketplace.js",
  );
  return {
    ...actual,
    resolveMarketplaceInstallShortcut: vi.fn(async () => null),
  };
});

vi.mock("../plugins/bundled-sources.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/bundled-sources.js")>(
    "../plugins/bundled-sources.js",
  );
  return {
    ...actual,
    findBundledPluginSource: vi.fn(() => null),
  };
});

vi.mock("./plugin-install-plan.js", async () => {
  const actual = await vi.importActual<typeof import("./plugin-install-plan.js")>(
    "./plugin-install-plan.js",
  );
  return {
    ...actual,
    resolveBundledInstallPlanBeforeNpm: vi.fn(() => null),
    resolveBundledInstallPlanForNpmFailure: vi.fn(() => null),
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ plugins: {} })),
    readConfigFileSnapshot: vi.fn(async () => ({
      path: "/tmp/config.json5",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: { plugins: {} },
      resolved: { plugins: {} },
      valid: true,
      runtimeConfig: { plugins: {} },
      config: { plugins: {} },
      hash: "x",
      issues: [],
      warnings: [],
      legacyIssues: [],
    })),
  };
});

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit-${code}`);
      }),
    },
  };
});

vi.mock("./plugins-install-persist.js", () => ({
  persistPluginInstall: vi.fn(async () => undefined),
  persistHookPackInstall: vi.fn(async () => undefined),
}));

vi.mock("../hooks/install.js", () => ({
  installHooksFromNpmSpec: vi.fn(async () => ({
    ok: false,
    code: "hook-miss",
    error: "no hook",
  })),
  installHooksFromPath: vi.fn(async () => ({
    ok: false,
    code: "hook-miss",
    error: "no hook",
  })),
}));

// Only import AFTER mocks are set up so the module resolves to our mocks.
async function loadCommand() {
  return (await import("./plugins-install-command.js")).runPluginInstallCommand;
}

describe("runPluginInstallCommand extensionsDir forwarding (issue #69960)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    hoisted.installFromNpmMock.mockClear();
    hoisted.installFromPathMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("forwards a profile-aware extensionsDir when OPENCLAW_STATE_DIR is set (Test A)", async () => {
    const profileStateDir = "/tmp/openclaw-test-profile-69960";
    process.env.OPENCLAW_STATE_DIR = profileStateDir;

    const runPluginInstallCommand = await loadCommand();
    // Use a plain npm-style spec (no path, no .ts suffix) so we reach
    // installPluginFromNpmSpec.
    try {
      await runPluginInstallCommand({
        raw: "some-nonexistent-test-package-69960",
        opts: {},
      });
    } catch {
      // ignore the thrown exit() from the mocked runtime when install returns !ok
    }

    expect(hoisted.installFromNpmMock).toHaveBeenCalledTimes(1);
    const call = hoisted.installFromNpmMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).toHaveProperty("extensionsDir");
    expect(call?.extensionsDir).toBe(path.join(profileStateDir, "extensions"));
    // Test C: the CLI call site sets the arg, so install.ts's default-fallback
    // branch (which otherwise reads a module-level CONFIG_DIR captured at
    // import time) is bypassed.
    expect(call?.extensionsDir).toBeTruthy();
  });

  it("forwards an extensionsDir derived from resolveStateDir when no override is set (Test B/C)", async () => {
    delete process.env.OPENCLAW_STATE_DIR;

    const runPluginInstallCommand = await loadCommand();
    try {
      await runPluginInstallCommand({
        raw: "another-nonexistent-test-package-69960",
        opts: {},
      });
    } catch {
      // swallow exit-1 from the mocked runtime
    }

    expect(hoisted.installFromNpmMock).toHaveBeenCalledTimes(1);
    const call = hoisted.installFromNpmMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    // The key invariant: the CLI layer ALWAYS passes a non-empty extensionsDir
    // so install.ts never reaches its stale-CONFIG_DIR fallback branch. The
    // exact value depends on the ambient state-dir resolution (HOME, legacy
    // dirs, etc.) which is covered by resolveStateDir's own tests.
    expect(typeof call?.extensionsDir).toBe("string");
    expect(call?.extensionsDir).toMatch(/extensions$/);
    expect((call?.extensionsDir as string).length).toBeGreaterThan("extensions".length);
  });
});
