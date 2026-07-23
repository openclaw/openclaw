import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigSnapshotForInstallPersist } from "../../plugins/install-persistence.js";
import { expectObjectFields, mockFirstObjectArg } from "../../test-utils/mock-call-assertions.js";
import { installPluginFromPluginsCommand } from "./commands-plugins-install.js";

const { installPluginFromClawHubMock, installPluginFromNpmSpecMock, persistPluginInstallMock } =
  vi.hoisted(() => ({
    installPluginFromClawHubMock: vi.fn(),
    installPluginFromNpmSpecMock: vi.fn(),
    persistPluginInstallMock: vi.fn(),
  }));

vi.mock("../../plugins/clawhub.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/clawhub.js")>(
    "../../plugins/clawhub.js",
  );
  return {
    ...actual,
    installPluginFromClawHub: installPluginFromClawHubMock,
  };
});

vi.mock("../../plugins/install.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/install.js")>(
    "../../plugins/install.js",
  );
  return {
    ...actual,
    installPluginFromNpmSpec: installPluginFromNpmSpecMock,
  };
});

vi.mock("../../plugins/install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install-persistence.js")>()),
  persistPluginInstall: persistPluginInstallMock,
}));

describe("official external plugin chat installs", () => {
  afterEach(() => {
    installPluginFromClawHubMock.mockReset();
    installPluginFromNpmSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
  });

  it("routes ClawHub-only official plugin ids through ClawHub", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "sherpa-onnx-tts",
      targetDir: "/tmp/sherpa-onnx-tts",
      version: "2026.6.8",
      extensions: ["index.js"],
      packageName: "@openclaw/sherpa-onnx-tts",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/sherpa-onnx-tts",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "2026.6.8",
        integrity: "sha512-sherpa",
        resolvedAt: "2026-06-08T12:00:00.000Z",
      },
    });
    persistPluginInstallMock.mockResolvedValue({});

    const result = await installPluginFromPluginsCommand({
      raw: "sherpa-onnx-tts",
      force: false,
      config: {},
      snapshot: {} as ConfigSnapshotForInstallPersist,
    });

    expect(result).toMatchObject({ ok: true, pluginId: "sherpa-onnx-tts" });
    expectObjectFields(mockFirstObjectArg(installPluginFromClawHubMock), {
      spec: "clawhub:@openclaw/sherpa-onnx-tts",
      expectedPluginId: "sherpa-onnx-tts",
    });
    expectObjectFields(mockFirstObjectArg(persistPluginInstallMock), {
      pluginId: "sherpa-onnx-tts",
      install: expect.objectContaining({
        source: "clawhub",
        spec: "clawhub:@openclaw/sherpa-onnx-tts",
        installPath: "/tmp/sherpa-onnx-tts",
      }),
    });
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });
});
