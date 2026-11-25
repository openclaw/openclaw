import fs from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { SnapshotSchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createSessionStoreSummaryReaderStub } from "../config/sessions/session-store-summary.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { formatHealthChannelLines } from "./health-format.js";
import { channelRuntime, pluginHealthError, unavailablePlugin } from "./health.test-fixtures.js";

const testConfig: OpenClawConfig = { session: { store: "/tmp/x" } };
const tempDirs = createTempDirTracker();
let sessionStorePath: string;

let setActivePluginRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let setActiveDegradedPlugins: typeof import("../plugins/runtime-degraded-state.js").setActiveDegradedPlugins;
let createTestRegistry: typeof import("../test-utils/channel-plugins.js").createTestRegistry;
let collectGatewayHealthSnapshot: typeof import("../gateway/health/collector.js").collectGatewayHealthSnapshot;
let startPluginServices: typeof import("../plugins/services.test-support.js").startPluginServices;
let pluginServicesHandle: PluginServicesHandle | undefined;
let inventoryPlugins: ChannelPlugin[] = [];
const collect = (options: Partial<Parameters<typeof collectGatewayHealthSnapshot>[0]> = {}) =>
  collectGatewayHealthSnapshot({ audience: "admin", probe: false, ...options });
const serviceEntry = (id: string, start: () => void, serviceId = id) => ({
  pluginId: "service-plugin",
  pluginName: "Service Plugin",
  id,
  service: { id: serviceId, start },
  source: "test",
  origin: "workspace" as const,
});
type PluginSeed = Parameters<typeof createPluginRecord>[0];
const pluginRegistry = (...plugins: PluginSeed[]) => ({
  ...createTestRegistry([]),
  plugins: plugins.map(createPluginRecord),
});
function failedPlugin(id: string, error: string, overrides: Partial<PluginSeed> = {}): PluginSeed {
  return { id, error, status: "error", activated: false, failurePhase: "load", ...overrides };
}

describe("collectGatewayHealthSnapshot plugin state", () => {
  beforeAll(async () => {
    vi.doMock("../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
      loadConfig: () => testConfig,
    }));
    vi.doMock("../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../config/sessions/session-entry-read-runtime.js", () => ({
      withSessionStoreReaderInWorker: createSessionStoreSummaryReaderStub(),
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => inventoryPlugins,
    }));

    ({ setActivePluginRegistry } = await import("../plugins/runtime.js"));
    ({ setActiveDegradedPlugins } = await import("../plugins/runtime-degraded-state.js"));
    ({ createTestRegistry } = await import("../test-utils/channel-plugins.js"));
    ({ collectGatewayHealthSnapshot } = await import("../gateway/health/collector.js"));
    ({ startPluginServices } = await import("../plugins/services.test-support.js"));
  });

  beforeEach(() => {
    sessionStorePath = path.join(tempDirs.make("health-plugins-"), "sessions.json");
  });

  afterEach(async () => {
    await pluginServicesHandle?.stop();
    pluginServicesHandle = undefined;
    setActiveDegradedPlugins([]);
    inventoryPlugins = [];
    delete testConfig.channels;
    setActivePluginRegistry(createTestRegistry([]));
    tempDirs.cleanup();
  });

  it("deduplicates canonical-root quarantine while retaining unrelated same-id errors", async () => {
    const importError = "unrelated import error";
    const fixtureDir = tempDirs.make("openclaw-health-plugin-");
    const pluginRoot = path.join(fixtureDir, "plugin");
    const pluginRootAlias = path.join(fixtureDir, "alias");
    fs.mkdirSync(pluginRoot);
    fs.symlinkSync(pluginRoot, pluginRootAlias, "dir");
    setActivePluginRegistry(
      pluginRegistry(
        failedPlugin("discord", "configured plugin payload verification failed", {
          origin: "global",
          rootDir: pluginRoot,
          activationReason: "configured-unavailable: unreadable-package-json",
          failurePhase: "validation",
        }),
        failedPlugin("discord", importError, {
          origin: "config",
          rootDir: "/workspace/discord",
        }),
      ),
    );
    setActiveDegradedPlugins([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "unreadable-package-json",
          detail: `Could not read ${pluginRootAlias}/package.json: permission denied`,
          installPath: pluginRootAlias,
        },
      },
    ]);

    const snap = await collect();

    expect(Value.Check(SnapshotSchema.properties.health, snap)).toBe(true);
    expect(snap.sessions.path).toBe(
      path.join(path.dirname(sessionStorePath), "openclaw-agent.sqlite"),
    );
    expect(snap.plugins?.unavailable).toEqual([
      unavailablePlugin(
        "discord",
        "Could not read <plugin-install>/package.json: permission denied",
      ),
    ]);
    expect(JSON.stringify(snap.plugins?.unavailable)).not.toContain(pluginRoot);
    expect(snap.plugins?.errors).toEqual([
      pluginHealthError("discord", importError, {
        origin: "config",
        activationSource: "explicit",
        failurePhase: "load",
      }),
    ]);
    expect(formatHealthChannelLines(snap)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Plugin discord: failed - .*unrelated import error/u),
        expect.stringMatching(
          /^Plugin discord: unavailable - unreadable-package-json: .*permission denied/u,
        ),
      ]),
    );
  });

  it("projects the recorded channel load failure instead of stale successful probes", async () => {
    const credential = "synthetic-health-loader-credential";
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const base = createChannelTestPluginBase({ id: "broken-channel" });
    inventoryPlugins = [
      {
        ...base,
        config: { ...base.config, listAccountIds: () => ["default", "disabled"] },
        status: { probeAccount },
      },
    ];
    testConfig.channels = { "broken-channel": { accounts: { Disabled: { enabled: false } } } };
    const registry = pluginRegistry(
      failedPlugin(
        "broken-owner",
        `missing SDK export; password=${credential}\n${"context ".repeat(300)}`,
        {
          activated: true,
          channelIds: ["broken-channel"],
        },
      ),
    );
    setActivePluginRegistry(registry);
    const snap = await collect({
      probe: true,
      runtimeSnapshot: channelRuntime(
        "broken-channel",
        { accountId: "default", running: true, connected: true, probe: { ok: true } },
        true,
      ),
    });
    expect(snap.channels["broken-channel"]).toMatchObject({
      configured: true,
      running: false,
      lifecycle: "blocked",
      lastError: expect.stringContaining("missing SDK export"),
      accounts: {
        disabled: {
          enabled: false,
          running: false,
          lastError: expect.stringContaining("missing SDK export"),
        },
      },
    });
    expect(snap.channels["broken-channel"]).not.toHaveProperty("probe");
    expect(JSON.stringify(snap)).not.toContain(credential);
    expect(snap.plugins?.errors[0]?.error.length).toBeLessThanOrEqual(1000);
    expect(probeAccount).not.toHaveBeenCalled();

    // A different live owner wins over a failed plugin declaring the same channel.
    setActivePluginRegistry({
      ...registry,
      ...createTestRegistry([
        { pluginId: "healthy-owner", plugin: inventoryPlugins[0], source: "test" },
      ]),
      plugins: registry.plugins,
    });
    const { resolveUnavailableChannelAccountSnapshot } =
      await import("../channels/status/account-state.js");
    expect(
      resolveUnavailableChannelAccountSnapshot(testConfig, {
        channelId: "broken-channel",
        accountId: "default",
      }),
    ).toBeUndefined();
  });

  it("surfaces a failed service while continuing healthy siblings", async () => {
    const credential = "synthetic-service-credential";
    const siblingStart = vi.fn();
    const brokenStart = vi.fn().mockImplementationOnce(() => {
      throw new Error(`listen EADDRINUSE: address already in use; password=${credential}`);
    });
    const registry = {
      ...pluginRegistry({
        id: "service-plugin",
        services: ["broken", "healthy-sibling"],
      }),
      services: [
        serviceEntry("broken", brokenStart, " broken "),
        serviceEntry("healthy-sibling", siblingStart),
      ],
    };
    setActivePluginRegistry(registry);

    pluginServicesHandle = await startPluginServices({ registry, config: {} });
    const failed = await collect();

    expect(Value.Check(SnapshotSchema.properties.health, failed)).toBe(true);
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(failed.plugins?.loaded).toContain("service-plugin");
    expect(failed.plugins?.errors).toContainEqual(
      pluginHealthError(
        "service-plugin",
        expect.stringContaining("service broken: listen EADDRINUSE: address already in use"),
        {
          activated: true,
          activationSource: "explicit",
          failurePhase: "service",
        },
      ),
    );
    expect(JSON.stringify(failed)).not.toContain(credential);

    await pluginServicesHandle.stop();
    pluginServicesHandle = undefined;
    const stopped = await collect();
    expect(stopped.plugins?.errors).toEqual(failed.plugins?.errors);

    pluginServicesHandle = await startPluginServices({ registry, config: {} });
    const recovered = await collect();
    expect(brokenStart).toHaveBeenCalledTimes(2);
    expect(siblingStart).toHaveBeenCalledTimes(2);
    expect(recovered.plugins?.errors).toEqual([]);
  });
});
