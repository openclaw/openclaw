// Exercise Commander, auth dispatch, and actual owner resolution with local I/O seams.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerChannelsCli } from "./channels-cli.js";

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  registered: true,
  login: vi.fn(),
  logout: vi.fn(async () => ({ cleared: false })),
  catalog: vi.fn<(...args: unknown[]) => ChannelPluginCatalogEntry[]>(() => []),
  loadScoped: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => fixture.config }));
vi.mock("../commands/config-validation.js", () => ({
  requireValidConfigForWrite: async () => ({
    snapshot: { sourceConfig: fixture.config, hash: "fixture" },
    writeOptions: {},
  }),
}));
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: OpenClawConfig }) => ({ config, changes: [] }),
}));
vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: fixture.catalog,
  getChannelPluginCatalogEntry: () => undefined,
}));
vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: (id: string) => id,
  getLoadedChannelPlugin: () => (fixture.registered ? plugin : undefined),
  listChannelPlugins: () => [plugin],
}));
vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  loadChannelSetupPluginRegistrySnapshotForChannel: fixture.loadScoped,
  ensureChannelSetupPluginInstalled: vi.fn(),
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: async () => {
    throw new Error("isolated fixture has no Gateway");
  },
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: fixture.runtime,
  ExitError: class extends Error {},
}));

const plugin = {
  id: "fixture-chat",
  auth: { login: fixture.login },
  gateway: { logoutAccount: fixture.logout },
  config: {
    listAccountIds: () => ["work"],
    resolveAccount: () => ({ accountId: "work" }),
  },
};

async function runAuth(mode: string, parent: string[] = [], leaf: string[] = []) {
  const args = ["channels", ...parent, mode, ...leaf, "--channel", plugin.id, "--account", "work"];
  const program = new Command()
    .name("openclaw")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
}

describe("channels auth owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.registered = true;
    fixture.config = {
      agents: {
        ownership: "explicit",
        entries: {
          research: { workspace: "/tmp/research-workspace" },
          ops: { workspace: "/tmp/ops-workspace" },
        },
      },
    };
    fixture.catalog.mockReturnValue([
      {
        id: plugin.id,
        pluginId: plugin.id,
        origin: "bundled",
        meta: {
          id: plugin.id,
          label: "Fixture",
          selectionLabel: "Fixture",
          docsPath: "",
          blurb: "",
        },
        install: { npmSpec: "fixture-chat" },
      },
    ]);
    fixture.loadScoped.mockReturnValue({ channels: [{ plugin }], channelSetups: [] });
  });

  it.each(["login", "logout"])(
    "retains the leaf owner through %s plugin discovery",
    async (mode) => {
      fixture.registered = false;
      await runAuth(mode, ["--agent", "research"], ["--agent", " ops "]);

      expect(fixture.runtime.error).not.toHaveBeenCalled();
      expect(fixture.loadScoped).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
      );
      expect(mode === "login" ? fixture.login : fixture.logout).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "work" }),
      );
    },
  );

  it("keeps an ownerless fleet from auth", async () => {
    await expect(runAuth("logout")).rejects.toMatchObject({
      name: "AgentSelectionRequiredError",
      message: expect.stringContaining("no explicit owner"),
    });
    expect(fixture.runtime.error).not.toHaveBeenCalled();
    expect(fixture.runtime.exit).not.toHaveBeenCalled();
    expect(fixture.catalog).not.toHaveBeenCalled();
    expect(fixture.loadScoped).not.toHaveBeenCalled();
    expect(fixture.login).not.toHaveBeenCalled();
    expect(fixture.logout).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "OPS", error: 'Unknown agent id "OPS"' },
    { agent: " ", error: "--agent must not be blank" },
  ])("rejects invalid explicit owner '$agent' before discovery", async ({ agent, error }) => {
    fixture.config.agents!.defaults = { systemAgent: { agentId: "research" } };
    await runAuth("logout", ["--agent", agent]);

    expect(fixture.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(fixture.runtime.exit).toHaveBeenCalledWith(1);
    expect(fixture.catalog).not.toHaveBeenCalled();
    expect(fixture.login).not.toHaveBeenCalled();
    expect(fixture.logout).not.toHaveBeenCalled();
  });
});
