// Bundled plugin install failures must never be reported as successful commands.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBundledPluginSourceMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  configWriteMock,
} from "./plugins-cli-test-helpers.js";

const { installManagedPluginSourceMock } = vi.hoisted(() => ({
  installManagedPluginSourceMock: vi.fn(),
}));

vi.mock("../plugins/management-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/management-install.js")>()),
  installManagedPluginSource: installManagedPluginSourceMock,
}));

describe("plugin install bundled failure propagation", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    installManagedPluginSourceMock.mockReset();
  });

  it("fails when direct bundled source execution fails", async () => {
    findBundledPluginSourceMock.mockReturnValue({
      pluginId: "bundled-demo",
      localPath: "/app/dist/extensions/bundled-demo",
    });
    installManagedPluginSourceMock.mockResolvedValue({
      ok: false,
      error: "bundled plugin installation failed",
    });

    await expect(runPluginsCommand(["plugins", "install", "bundled-demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installManagedPluginSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ source: "bundled" }),
      }),
    );
    expect(runtimeErrors.at(-1)).toContain("bundled plugin installation failed");
    expect(configWriteMock).not.toHaveBeenCalled();
  });
});
