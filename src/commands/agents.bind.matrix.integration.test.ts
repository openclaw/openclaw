import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const matrixBindingPlugin = {
  ...createChannelTestPluginBase({ id: "matrix" }),
  setup: {
    resolveBindingAccountId: ({ accountId, agentId }: { accountId?: string; agentId?: string }) => {
      const explicit = accountId?.trim();
      if (explicit) {
        return explicit;
      }
      const agent = agentId?.trim();
      return agent || "default";
    },
  },
};

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

let agentsBindCommand: typeof import("./agents.js").agentsBindCommand;

describe("agents bind matrix integration", () => {
  const runtime = createTestRuntime();

  beforeEach(async () => {
    vi.resetModules();
    ({ agentsBindCommand } = await import("./agents.js"));
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    setDefaultChannelPluginRegistryForTests();
  });

  it("uses matrix plugin binding resolver when accountId is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ agent: "main", bind: ["matrix"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [
          { type: "route", agentId: "main", match: { channel: "matrix", accountId: "main" } },
        ],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
