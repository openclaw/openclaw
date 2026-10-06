// Root help tests cover top-level help rendering and command visibility.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { outputRootHelp } from "./root-help.js";

const getPluginCliCommandDescriptorsMock = vi.fn(
  async (_configForTest?: unknown, _env?: unknown, _loaderOptions?: unknown) => [
    {
      name: "matrix",
      description: "Matrix channel utilities",
      hasSubcommands: true,
    },
  ],
);

vi.mock("./core-command-descriptors.js", () => ({
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
  getCoreCliCommandsWithSubcommands: () => [],
}));

vi.mock("./subcli-descriptors.js", () => ({
  SUB_CLI_DESCRIPTORS: [
    {
      name: "config",
      description: "Manage config",
      hasSubcommands: true,
    },
  ],
  getSubCliEntriesCore: () => [
    {
      name: "config",
      description: "Manage config",
      hasSubcommands: true,
    },
  ],
  getSubCliCommandsWithSubcommands: () => ["config"],
}));

vi.mock("../../plugins/cli-root-descriptors.js", () => ({
  getPluginCliCommandDescriptors: (...args: [unknown?, unknown?, unknown?]) =>
    getPluginCliCommandDescriptorsMock(...args),
}));

describe("root help", () => {
  let text = "";
  beforeEach(() => {
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
    expect(text).toContain("config");
    expect(text).toContain("matrix");
    expect(text).toContain("matrix *");
    expect(text).toContain("Matrix channel utilities");
  });

  it("does not load plugin CLI descriptors by default", async () => {
    await outputRootHelp();

    expect(getPluginCliCommandDescriptorsMock).not.toHaveBeenCalled();
  });
});
