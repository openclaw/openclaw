import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const clientMocks = vi.hoisted(() => ({
  browserSnapshot: vi.fn(async () => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
  resolveBrowserControlUrl: vi.fn(() => "http://127.0.0.1:18791"),
}));
vi.mock("../browser/client.js", () => clientMocks);

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("../config/config.js", () => configMocks);

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};
vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

describe("browser cli snapshot defaults", () => {
  afterEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockReturnValue({ browser: {} });
  });

  it("uses config snapshot defaults when mode is not provided", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });
    const { registerBrowserInspectCommands } = await import("./browser-cli-inspect.js");
    const program = new Command();
    const browser = program.command("browser").option("--json", false);
    registerBrowserInspectCommands(browser, () => ({}));

    await program.parseAsync(["browser", "snapshot"], { from: "user" });

    expect(clientMocks.browserSnapshot).toHaveBeenCalledWith(
      "http://127.0.0.1:18791",
      expect.objectContaining({
        format: "ai",
        mode: "efficient",
      }),
    );
  });

  it("does not apply config snapshot defaults to aria snapshots", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });
    clientMocks.browserSnapshot.mockResolvedValueOnce({
      ok: true,
      format: "aria",
      targetId: "t1",
      url: "https://example.com",
      nodes: [],
    });
    const { registerBrowserInspectCommands } = await import("./browser-cli-inspect.js");
    const program = new Command();
    const browser = program.command("browser").option("--json", false);
    registerBrowserInspectCommands(browser, () => ({}));

    await program.parseAsync(["browser", "snapshot", "--format", "aria"], { from: "user" });

    expect(clientMocks.browserSnapshot).toHaveBeenCalled();
    const [, opts] = clientMocks.browserSnapshot.mock.calls.at(-1) ?? [];
    expect(opts?.mode).toBeUndefined();
  });
});
