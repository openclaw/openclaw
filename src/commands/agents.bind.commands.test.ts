import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBindingResolverTestPlugin } from "../test-utils/channel-plugins.js";
import {
  loadFreshAgentsBindCommandModuleForTest,
  readConfigFileSnapshotMock,
  resetAgentsBindTestHarness,
  runtime,
  writeConfigFileMock,
} from "./agents.bind.test-support.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  const knownChannels = new Map([
    [
      "discord",
      createBindingResolverTestPlugin({ id: "discord", config: { listAccountIds: () => [] } }),
    ],
    [
      "matrix",
      createBindingResolverTestPlugin({
        id: "matrix",
        config: { listAccountIds: () => [] },
        resolveBindingAccountId: ({ agentId }) => agentId.toLowerCase(),
      }),
    ],
    [
      "telegram",
      createBindingResolverTestPlugin({ id: "telegram", config: { listAccountIds: () => [] } }),
    ],
  ]);
  return {
    ...actual,
    getChannelPlugin: (channel: string) => {
      const normalized = channel.trim().toLowerCase();
      const plugin = knownChannels.get(normalized);
      if (plugin) {
        return plugin;
      }
      return actual.getChannelPlugin(channel);
    },
    normalizeChannelId: (channel: string) => {
      const normalized = channel.trim().toLowerCase();
      if (knownChannels.has(normalized)) {
        return normalized;
      }
      return actual.normalizeChannelId(channel);
    },
  };
});

let agentsBindCommand: typeof import("./agents.commands.bind.js").agentsBindCommand;
let agentsBindingsCommand: typeof import("./agents.commands.bind.js").agentsBindingsCommand;
let agentsUnbindCommand: typeof import("./agents.commands.bind.js").agentsUnbindCommand;

describe("agents bind/unbind commands", () => {
  beforeEach(async () => {
    ({ agentsBindCommand, agentsBindingsCommand, agentsUnbindCommand } =
      await loadFreshAgentsBindCommandModuleForTest());
    resetAgentsBindTestHarness();
  });

  it("lists all bindings by default", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        bindings: [
          { agentId: "main", match: { channel: "matrix" } },
          { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
        ],
      },
    });

    await agentsBindingsCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("main <- matrix"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("ops <- telegram accountId=work"),
    );
  });

  it("binds routes to default agent when --agent is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ bind: ["telegram"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ type: "route", agentId: "main", match: { channel: "telegram" } }],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("defaults matrix accountId to the target agent id when omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ agent: "main", bind: ["matrix"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [
          {
            type: "route",
            agentId: "main",
            match: { channel: "matrix", accountId: "main" },
          },
        ],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("upgrades existing channel-only binding when accountId is later provided", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        bindings: [{ agentId: "main", match: { channel: "telegram" } }],
      },
    });

    await agentsBindCommand({ bind: ["telegram:work"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "work" } }],
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("Updated bindings:");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("unbinds all routes for an agent", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: { list: [{ id: "ops", workspace: "/tmp/ops" }] },
        bindings: [
          { agentId: "main", match: { channel: "matrix" } },
          { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
        ],
      },
    });

    await agentsUnbindCommand({ agent: "ops", all: true }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ agentId: "main", match: { channel: "matrix" } }],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports ownership conflicts during unbind and exits 1", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: { list: [{ id: "ops", workspace: "/tmp/ops" }] },
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "ops" } }],
      },
    });

    await agentsUnbindCommand({ agent: "ops", bind: ["telegram:ops"] }, runtime);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Bindings are owned by another agent:");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps role-based bindings when removing channel-level discord binding", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "discord",
              accountId: "guild-a",
              roles: ["111", "222"],
            },
          },
          {
            agentId: "main",
            match: {
              channel: "discord",
              accountId: "guild-a",
            },
          },
        ],
      },
    });

    await agentsUnbindCommand({ bind: ["discord:guild-a"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [
          {
            agentId: "main",
            match: {
              channel: "discord",
              accountId: "guild-a",
              roles: ["111", "222"],
            },
          },
        ],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
