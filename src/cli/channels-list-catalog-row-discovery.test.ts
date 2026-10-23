import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  json: [] as unknown[],
  catalogEntries: [] as ChannelPluginCatalogEntry[],
  manifestRegistryRebuilds: 0,
}));

vi.mock("../plugins/plugin-registry-contributions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/plugin-registry-contributions.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: (
      ...args: Parameters<typeof actual.loadPluginManifestRegistryForPluginRegistry>
    ) => {
      testState.manifestRegistryRebuilds += 1;
      return actual.loadPluginManifestRegistryForPluginRegistry(...args);
    },
  };
});

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));
vi.mock("../commands/channels/shared.js", () => ({
  formatChannelAccountLabel: vi.fn(),
  requireValidChannelConfig: vi.fn(async () => testState.config),
}));
vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: vi.fn(() => testState.catalogEntries),
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => undefined),
  resolveDefaultAgentId: vi.fn(() => "main"),
  tryResolveConfiguredAgentWorkspaceDir: vi.fn(() => undefined),
  tryResolveSystemAgentWorkspaceDir: vi.fn(() => undefined),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
    writeJson: (value: unknown) => testState.json.push(value),
    writeStdout: vi.fn(),
  },
  writeRuntimeJson: vi.fn((runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
  ),
}));

import { tryRouteCli } from "./route.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channels-list-catalog-rows-"));

// Configured official external channels with missing owners exercise row repair hints.
const OWNERLESS_CHANNEL_IDS = ["feishu", "googlechat", "matrix", "twitch"] as const;

async function runChannelsListJson(channelIds: readonly string[]) {
  testState.catalogEntries = channelIds.map(
    (id) =>
      ({
        id,
        meta: { label: id },
        install: { npmSpec: `@openclaw/${id}` },
      }) as ChannelPluginCatalogEntry,
  );
  testState.config = {
    channels: Object.fromEntries(channelIds.map((channelId) => [channelId, { enabled: true }])),
  } as OpenClawConfig;
  testState.json = [];
  testState.manifestRegistryRebuilds = 0;
  await expect(tryRouteCli(["node", "openclaw", "channels", "list", "--json"])).resolves.toBe(true);
  return {
    rebuilds: testState.manifestRegistryRebuilds,
    chat: (testState.json[0] as { chat: unknown }).chat,
  };
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  testState.json = [];
  testState.catalogEntries = [];
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

it.each([
  { name: "top-level", channel: { token: "configured" }, accounts: ["default"] },
  {
    name: "named",
    channel: { accounts: { alerts: { token: "configured" }, default: { token: "configured" } } },
    accounts: ["alerts", "default"],
  },
])(
  "renders $name channel accounts without loading setup or runtime",
  async ({ name, channel, accounts }) => {
    const pluginRoot = path.join(tempRoot, name);
    fs.mkdirSync(pluginRoot, { recursive: true });
    const setupMarker = path.join(pluginRoot, "setup-loaded.txt");
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "cold-channel-plugin",
      channelId: "cold-channel",
      setupEntrySource: `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded");
throw new Error("JSON inventory must not execute setup");`,
      manifest: {
        channelConfigs: {
          "cold-channel": {
            schema: { type: "object" },
            label: "Cold Channel",
          },
        },
      },
    });
    testState.config = {
      channels: { "cold-channel": channel },
      ...createColdPluginConfig(pluginRoot, fixture.pluginId),
    };
    for (const flags of [["--json"], ["--all", "--json"]]) {
      await expect(tryRouteCli(["node", "openclaw", "channels", "list", ...flags])).resolves.toBe(
        true,
      );
    }
    const expected = {
      chat: {
        "cold-channel": { label: "Cold Channel", accounts, installed: true, origin: "configured" },
      },
    };
    expect(testState.json).toEqual([expected, expected]);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  },
);

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("resolves catalog-row repair hints without rebuilding the manifest registry", async () => {
  const empty = await runChannelsListJson([]);
  const rows = await runChannelsListJson(OWNERLESS_CHANNEL_IDS);

  // Every row still resolves its repair hint, so the presence policy really ran.
  expect(rows.chat).toEqual(
    Object.fromEntries(
      OWNERLESS_CHANNEL_IDS.map((channelId) => [
        channelId,
        { label: channelId, accounts: [], installed: false, origin: "configured" },
      ]),
    ),
  );
  // Discovery is prepared once per invocation, so row count cannot move this number.
  expect({ noRows: empty.rebuilds, fourRows: rows.rebuilds }).toEqual({ noRows: 0, fourRows: 0 });
});
