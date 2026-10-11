import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import { createConfigIO, readConfigFileSnapshot } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as setupShared from "../../wizard/setup.shared.js";
import { registerConfigureCommand } from "./register.configure.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  outro: vi.fn(),
  createClackPrompter: vi.fn(),
  listPlugins: vi.fn<() => ChannelSetupPlugin[]>(),
  discover:
    vi.fn<typeof import("../../commands/channel-setup/discovery.js").resolveChannelSetupEntries>(),
  health: vi.fn<typeof import("../../commands/health.js").healthCommandNonExiting>(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  },
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
vi.mock("../terminal-interactivity.js", () => ({ isTerminalInteractive: () => true }));
vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/configure.shared.js")>()),
  intro: vi.fn(),
  outro: mocks.outro,
  select: mocks.select,
}));
vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));
vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../../commands/onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/onboard-helpers.js")>()),
  probeGatewayReachable: vi.fn(async () => ({ ok: true })),
  waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../commands/health.js", () => ({ healthCommandNonExiting: mocks.health }));
vi.mock("../../channels/plugins/setup-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/setup-registry.js")>()),
  listActiveChannelSetupPlugins: mocks.listPlugins,
}));
vi.mock("../../commands/channel-setup/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/channel-setup/discovery.js")>()),
  resolveChannelSetupEntries: mocks.discover,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("registered configure persistence", () => {
  it("continues with canonical config after the committed-path channel callback", async () => {
    await withOpenClawTestState(
      {
        label: "registered-configure-post-write",
        layout: "split",
        env: { SETUP_REPLY_PREFIX: "resolved prefix" },
      },
      async (state) => {
        const includePath = state.path("config", "tools.json5");
        await state.writeConfig({
          messages: { responsePrefix: "${SETUP_REPLY_PREFIX}" },
          tools: { $include: "tools.json5" },
          gateway: { mode: "local", port: 19001 },
          agents: {
            ownership: "explicit",
            defaults: { workspace: state.workspaceDir },
            entries: { main: {} },
          },
          commands: { ownerAllowFrom: ["telegram:123"] },
        });
        const includeRaw = JSON.stringify({ web: { fetch: { enabled: false } } });
        await fs.writeFile(includePath, includeRaw);
        const before = await readConfigFileSnapshot();
        expect(before.valid).toBe(true);
        const events: string[] = [];
        const afterConfigWritten = vi.fn(async () => {
          events.push("callback");
        });
        const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => {
          events.push("channel setup");
          return {
            cfg: { ...cfg, gateway: { ...cfg.gateway, port: 19002 } },
            accountId: "ops",
          };
        });
        const plugin: ChannelSetupPlugin = {
          ...createChannelTestPluginBase({ id: "telegram", label: "Fixture channel" }),
          setupWizard: {
            channel: "telegram",
            getStatus: async () => ({
              channel: "telegram",
              configured: false,
              statusLines: [],
            }),
            configure,
            afterConfigWritten,
          },
        };
        const catalogEntry = {
          id: "telegram",
          meta: plugin.meta,
          install: { npmSpec: "@openclaw/test-channel" },
        };
        mocks.listPlugins.mockReturnValue([plugin]);
        mocks.discover.mockReturnValue({
          entries: [catalogEntry],
          installedCatalogEntries: [catalogEntry],
          installableCatalogEntries: [],
          installedCatalogById: new Map([["telegram", catalogEntry]]),
          installableCatalogById: new Map(),
        });
        mocks.select.mockResolvedValueOnce("local").mockResolvedValueOnce("configure");
        mocks.createClackPrompter.mockReturnValue(
          createWizardPrompter({}, { selectValues: ["telegram", "__done__"] }),
        );
        mocks.health.mockImplementation(async () => {
          events.push("health continuation");
        });
        const decoy = state.path("decoy.json");
        const decoyRaw = JSON.stringify({ messages: { responsePrefix: "wrong file" } });
        await fs.writeFile(decoy, decoyRaw);
        let committed: Awaited<ReturnType<typeof setupShared.writeWizardConfigFile>> | undefined;
        let persisted: ConfigFileSnapshot | undefined;
        const writeWizardConfigFile = setupShared.writeWizardConfigFile;
        vi.spyOn(setupShared, "writeWizardConfigFile").mockImplementation(async (...args) => {
          committed = await writeWizardConfigFile(...args);
          persisted = await createConfigIO({
            configPath: committed.path,
            observe: false,
          }).readConfigFileSnapshot();
          events.push("persisted");
          process.env.OPENCLAW_CONFIG_PATH = decoy;
          return committed;
        });
        const program = new Command();
        registerConfigureCommand(program);

        await program.parseAsync(["configure", "--section", "channels", "--section", "health"], {
          from: "user",
        });

        const receipt = expectDefined(committed, "registered configure write receipt");
        const snapshot = expectDefined(persisted, "canonical committed config");
        expect(events).toEqual(["channel setup", "persisted", "callback", "health continuation"]);
        expect(receipt.path).toBe(state.configPath);
        expect(snapshot.valid).toBe(true);
        expect({ config: receipt.nextConfig, hash: receipt.persistedHash }).toEqual({
          config: snapshot.sourceConfig,
          hash: snapshot.hash,
        });
        expect(receipt.persistedHash).not.toBe(hashConfigRaw(snapshot.raw));
        expect(receipt.nextConfig.messages?.responsePrefix).toBe("resolved prefix");
        expect(JSON.parse(await fs.readFile(receipt.path, "utf8"))).toMatchObject({
          messages: { responsePrefix: "${SETUP_REPLY_PREFIX}" },
          tools: { $include: "tools.json5" },
          gateway: { port: 19002 },
        });
        expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
        expect(afterConfigWritten).toHaveBeenCalledExactlyOnceWith({
          previousCfg: before.sourceConfig,
          cfg: snapshot.runtimeConfig,
          accountId: "ops",
          runtime: mocks.runtime,
        });
        expect(mocks.health).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ config: snapshot.sourceConfig }),
          mocks.runtime,
        );
        expect(await fs.readFile(decoy, "utf8")).toBe(decoyRaw);
        expect(mocks.outro).toHaveBeenCalledWith("Configuration updated.");
        expect(mocks.runtime.error).not.toHaveBeenCalled();
        expect(mocks.runtime.exit).not.toHaveBeenCalled();
      },
    );
  });
});
