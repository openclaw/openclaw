// Root help tests cover top-level help rendering and command visibility.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { outputRootHelp } from "./root-help.js";

const getPluginCliCommandDescriptorsMock = vi.fn(
  async (
    _configForTest?: unknown,
    _env?: unknown,
    _loaderOptions?: unknown,
  ): Promise<NamedCommandDescriptor[]> => [
    {
      name: "matrix",
      description: "Matrix channel utilities",
      hasSubcommands: true,
    },
  ],
);

vi.mock("./core-command-descriptors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./core-command-descriptors.js")>()),
  CORE_CLI_COMMAND_DESCRIPTORS: [
    {
      name: "status",
      description: "Show status",
      hasSubcommands: false,
    },
  ],
  getCoreCliCommandDescriptors: () => [
    {
      name: "status",
      description: "Show status",
      hasSubcommands: false,
    },
  ],
}));

vi.mock("../../plugins/cli-root-descriptors.js", () => ({
  getPluginCliCommandDescriptors: (...args: [unknown?, unknown?, unknown?]) =>
    getPluginCliCommandDescriptorsMock(...args),
}));

describe("root help", () => {
  let text = "";
  beforeEach(() => {
    const originalEnv = captureEnv(["OPENCLAW_ENABLE_PRIVATE_QA_CLI"]);
    onTestFinished(() => originalEnv.restore());
    text = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    onTestFinished(() => write.mockRestore());
    getPluginCliCommandDescriptorsMock.mockClear();
  });

  it("passes isolated config and env through to plugin CLI descriptor loading", async () => {
    const config = {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-root-help-workspace",
        },
      },
    };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-root-help-state" } as NodeJS.ProcessEnv;

    await outputRootHelp({ config, env, pluginSdkResolution: "src" });

    expect(getPluginCliCommandDescriptorsMock).toHaveBeenCalledWith(config, env, {
      pluginSdkResolution: "src",
    });
  });

  it("includes plugin CLI descriptors alongside core and sub-CLI commands", async () => {
    await outputRootHelp({ config: {} });

    expect(text).toContain("status");
    expect(text).toContain("gateway *");
    expect(text).toContain("matrix");
    expect(text).toContain("matrix *");
    expect(text).toContain("Matrix channel utilities");
  });

  it("does not load plugin CLI descriptors by default", async () => {
    await outputRootHelp();

    expect(getPluginCliCommandDescriptorsMock).not.toHaveBeenCalled();
  });

  it("strips unsafe terminal escapes from plugin command descriptions", async () => {
    getPluginCliCommandDescriptorsMock.mockResolvedValueOnce([
      {
        name: "safe-command",
        description: "Open \u001B]8;;https://example.test\u0007link\u001B]8;;\u0007 now\u001B[2J",
        hasSubcommands: false,
      },
    ]);
    await outputRootHelp({ config: {} });
    expect(text).toContain("Open link now");
    expect(text).not.toContain("\u001B]8");
    expect(text).not.toContain("\u001B[2J");
  });

  it("keeps hidden plugin descriptors out of help", async () => {
    getPluginCliCommandDescriptorsMock.mockResolvedValueOnce([
      { name: "visible", description: "Visible", hasSubcommands: false },
      { name: "retired", description: "Retired", hasSubcommands: false, hidden: true },
    ]);
    await outputRootHelp({ config: {} });
    expect(text).toContain("visible");
    expect(text).not.toContain("retired");
  });

  it("rejects unsafe plugin command names without emitting help", async () => {
    getPluginCliCommandDescriptorsMock.mockResolvedValueOnce([
      { name: "bad\nname", description: "Bad", hasSubcommands: false },
    ]);
    await expect(outputRootHelp({ config: {} })).rejects.toThrow(
      'Invalid CLI command name: "bad\\nname"',
    );
    expect(text).toBe("");
  });

  it("keeps the first core, sub-CLI and normalized plugin command descriptions", async () => {
    getPluginCliCommandDescriptorsMock.mockResolvedValueOnce([
      { name: "status", description: "Ignored core duplicate", hasSubcommands: false },
      { name: "gateway", description: "Ignored sub-CLI duplicate", hasSubcommands: true },
      { name: " alpha ", description: "First alpha", hasSubcommands: false },
      { name: "alpha", description: "Ignored normalized duplicate", hasSubcommands: false },
    ]);
    await outputRootHelp({ config: {} });
    expect(text).toContain("Show status");
    expect(text).toContain("gateway *");
    expect(text).toContain("First alpha");
    expect(text).not.toContain("Ignored");
    expect(text.match(/^\s+alpha\s+/gm)).toHaveLength(1);
  });

  it.each([undefined, "1"])(
    "shows private QA help only when enabled (%s) (#83926)",
    async (enabled) => {
      if (enabled === undefined) {
        delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
      } else {
        process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = enabled;
      }

      await outputRootHelp();

      expect(/^\s+qa(?:\s+\*)?\s+Run QA scenarios/m.test(text)).toBe(enabled === "1");
    },
  );
});
