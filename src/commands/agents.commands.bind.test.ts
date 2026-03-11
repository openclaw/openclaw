import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../channels/plugins/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/index.js")>();
  return {
    ...actual,
    getChannelPlugin: (channel: string) => {
      if (channel === "matrix-js") {
        return {
          id: "matrix-js",
          setup: {
            resolveBindingAccountId: ({ agentId }: { agentId: string }) => agentId.toLowerCase(),
          },
        };
      }
      // Support test-only channels for crossChannelMemory tests
      if (["webchat", "dingtalk"].includes(channel)) {
        return {
          id: channel,
          meta: {
            id: channel,
            label: channel,
            selectionLabel: channel,
            docsPath: `/channels/${channel}`,
            blurb: "test channel",
          },
          capabilities: { chatTypes: ["direct"] as const },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        };
      }
      return actual.getChannelPlugin(channel);
    },
    normalizeChannelId: (channel: string) => {
      const normalized = channel.trim().toLowerCase();
      if (normalized === "matrix-js") {
        return "matrix-js";
      }
      // Support test-only channels for crossChannelMemory tests
      if (normalized === "webchat" || normalized === "dingtalk") {
        return normalized;
      }
      return actual.normalizeChannelId(channel);
    },
  };
});

import { agentsBindCommand, agentsBindingsCommand, agentsUnbindCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents bind/unbind commands", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("lists all bindings by default", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        bindings: [
          { agentId: "main", match: { channel: "matrix-js" } },
          { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
        ],
      },
    });

    await agentsBindingsCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("main <- matrix-js"));
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
        bindings: [{ agentId: "main", match: { channel: "telegram" } }],
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("defaults matrix-js accountId to the target agent id when omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await agentsBindCommand({ agent: "main", bind: ["matrix-js"] }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ agentId: "main", match: { channel: "matrix-js", accountId: "main" } }],
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
          { agentId: "main", match: { channel: "matrix-js" } },
          { agentId: "ops", match: { channel: "telegram", accountId: "work" } },
        ],
      },
    });

    await agentsUnbindCommand({ agent: "ops", all: true }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [{ agentId: "main", match: { channel: "matrix-js" } }],
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

  it("enables crossChannelMemory when --share-memory flag is provided", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          defaults: { agent: "main" },
          list: [{ id: "main" }],
        },
      },
    });

    await agentsBindCommand({ bind: ["webchat", "dingtalk"], shareMemory: true }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: {
          defaults: { agent: "main" },
          list: [
            expect.objectContaining({
              id: "main",
              crossChannelMemory: true,
            }),
          ],
        },
        bindings: expect.arrayContaining([
          expect.objectContaining({ match: { channel: "webchat" } }),
          expect.objectContaining({ match: { channel: "dingtalk" } }),
        ]),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("Enabled cross-channel shared memory.");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not enable crossChannelMemory when --share-memory flag is omitted", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          defaults: { agent: "main" },
          list: [{ id: "main" }],
        },
      },
    });

    await agentsBindCommand({ bind: ["webchat"] }, runtime);

    const callArg = writeConfigFileMock.mock.calls[0]?.[0];
    expect(callArg?.agents?.list?.[0]?.crossChannelMemory).toBeUndefined();
    expect(runtime.log).not.toHaveBeenCalledWith("Enabled cross-channel shared memory.");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves existing agent config when enabling crossChannelMemory", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          defaults: { agent: "main" },
          list: [
            {
              id: "main",
              name: "My Assistant",
              model: { primary: "gpt-4" },
            },
          ],
        },
      },
    });

    await agentsBindCommand({ bind: ["webchat"], shareMemory: true }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: {
          defaults: { agent: "main" },
          list: [
            expect.objectContaining({
              id: "main",
              name: "My Assistant",
              model: { primary: "gpt-4" },
              crossChannelMemory: true,
            }),
          ],
        },
      }),
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("includes crossChannelMemory in JSON output", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        agents: {
          defaults: { agent: "main" },
          list: [{ id: "main" }],
        },
      },
    });

    await agentsBindCommand({ bind: ["webchat"], shareMemory: true, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"crossChannelMemory": true'));
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
