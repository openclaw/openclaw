import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const loadConfigMock = vi.fn(() => ({}));
const installPluginFromNpmSpecMock = vi.fn();
const persistPluginConfigWriteMock = vi.fn(async (_cfg: Record<string, unknown>) => {});
const clearPluginManifestRegistryCacheMock = vi.fn();
const buildPluginStatusReportMock = vi.fn(() => ({
  workspaceDir: "/tmp/workspace",
  diagnostics: [],
  plugins: [{ id: "demo", kind: "integration" }],
}));
const applyExclusiveSlotSelectionMock = vi.fn(
  ({ config }: { config: Record<string, unknown> }) => ({
    config,
    warnings: [],
  }),
);
const runtimeLogMock = vi.fn();
const runtimeErrorMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  installPluginFromPath: vi.fn(),
}));

vi.mock("../plugins/config-write.js", () => ({
  persistPluginConfigWrite: (cfg: Record<string, unknown>) => persistPluginConfigWriteMock(cfg),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  clearPluginManifestRegistryCache: () => clearPluginManifestRegistryCacheMock(),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: () => buildPluginStatusReportMock(),
}));

vi.mock("../plugins/slots.js", () => ({
  applyExclusiveSlotSelection: (params: { config: Record<string, unknown> }) =>
    applyExclusiveSlotSelectionMock(params),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => runtimeLogMock(...args),
    error: (...args: unknown[]) => runtimeErrorMock(...args),
  },
}));

describe("plugins cli install config writes", () => {
  let registerPluginsCli: (typeof import("./plugins-cli.js"))["registerPluginsCli"];

  beforeAll(async () => {
    ({ registerPluginsCli } = await import("./plugins-cli.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/extensions/demo",
      version: "1.2.3",
      extensions: ["./dist/index.js"],
      npmResolution: {
        name: "@openclaw/demo",
        version: "1.2.3",
        resolvedSpec: "@openclaw/demo@1.2.3",
        integrity: "sha512-demo",
        shasum: "deadbeef",
        resolvedAt: "2026-03-09T00:00:00.000Z",
      },
    });
  });

  it("routes plugin install writes through the include-preserving plugin config writer", async () => {
    await runRegisteredCli({
      register: (program: Command) => registerPluginsCli(program),
      argv: ["plugins", "install", "@openclaw/demo"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(clearPluginManifestRegistryCacheMock).toHaveBeenCalledTimes(1);
    expect(persistPluginConfigWriteMock).toHaveBeenCalledTimes(1);
    expect(persistPluginConfigWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            demo: expect.objectContaining({ enabled: true }),
          }),
          installs: expect.objectContaining({
            demo: expect.objectContaining({
              source: "npm",
              installPath: "/tmp/extensions/demo",
            }),
          }),
        }),
      }),
    );
  });
});
