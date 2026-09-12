import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  clearInstanceBindingProbeCoordinators,
  installInstanceBindingProbeCoordinator,
  INSTANCE_BINDING_PROBE_METHOD,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import { installInstanceBindingConfigIo } from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Keep hosted catalog transport outside this loader lifecycle proof.
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted" as const,
    entries: [],
  }),
}));

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
installInstanceBindingConfigIo();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it(
  "keeps startup errors diagnostic while healthy plugins reload and disable",
  { timeout: 120_000 },
  async () => {
    const coordinator = installInstanceBindingProbeCoordinator();
    const bundledRoot = tempDirs.make("openclaw-startup-error-");
    await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName);
    const brokenDir = path.join(bundledRoot, "startup-broken");
    await fs.mkdir(brokenDir);
    await fs.writeFile(
      path.join(brokenDir, "package.json"),
      JSON.stringify({
        name: "startup-broken",
        type: "commonjs",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(
      path.join(brokenDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "startup-broken",
        activation: { onStartup: true },
        configSchema: { type: "object" },
      }),
    );
    await fs.writeFile(
      path.join(brokenDir, "index.js"),
      'throw new Error("startup failure remains diagnostic");',
    );
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    assert(configPath);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          allow: ["startup-broken", "instance-binding-probe"],
          entries: {
            "startup-broken": { enabled: true },
            "instance-binding-probe": { enabled: true },
          },
        },
      }),
    );
    const port = await getFreePort();
    const recovery = vi.fn(() => ({ status: "emitted" as const }));
    const server = await startTestGatewayServer(port, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      sidecarStartup: "start",
      hotReloadRecovery: recovery,
    });
    let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
    try {
      await server.startupSettled;
      socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      const initial = getActivePluginRegistry();
      assert(initial);
      const broken = initial.plugins.find((record) => record.id === "startup-broken");
      expect(broken).toMatchObject({
        status: "error",
        error: expect.stringContaining("startup failure remains diagnostic"),
      });
      const diagnostics = initial.diagnostics.filter(
        (entry) => entry.pluginId === "startup-broken",
      );
      expect(diagnostics.length).toBeGreaterThan(0);
      const before = await rpcReq(socket, INSTANCE_BINDING_PROBE_METHOD, {});
      expect(before.ok, before.error?.message).toBe(true);
      const reload = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      expect(reload, reload.error?.message).toMatchObject({
        ok: true,
        payload: { restartRequired: false, runtime: { pluginIds: ["instance-binding-probe"] } },
      });
      const current = getActivePluginRegistry();
      assert(current);
      expect(current).not.toBe(initial);
      expect(current.plugins.find((record) => record.id === "startup-broken")).toBe(broken);
      expect(current.diagnostics.filter((entry) => entry.pluginId === "startup-broken")).toEqual(
        diagnostics,
      );
      const after = await rpcReq(socket, INSTANCE_BINDING_PROBE_METHOD, {});
      expect(after.ok, after.error?.message).toBe(true);
      expect(after.payload?.registryId).not.toBe(before.payload?.registryId);

      coordinator.channel = {
        ...createChannelTestPluginBase({ id: "replacement-channel" }),
        get id(): string {
          throw new Error("new candidate failure");
        },
      };
      const rejected = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "prepare" } } },
      });
      expect(rejected.error?.message).toContain("new candidate failure");
      expect(rejected.error?.message).not.toContain("startup-broken");
      expect(getActivePluginRegistry()).toBe(current);
      const retained = await rpcReq(socket, INSTANCE_BINDING_PROBE_METHOD, {});
      expect(retained.payload).toEqual(after.payload);

      const retryBroken = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "startup-broken" }],
      });
      expect(retryBroken).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "prepare" } } },
      });
      expect(retryBroken.error?.message).toContain("startup-broken");
      expect(getActivePluginRegistry()).toBe(current);

      const disabled = await rpcReq(socket, "plugins.setEnabled", {
        pluginId: "instance-binding-probe",
        enabled: false,
      });
      expect(disabled, disabled.error?.message).toMatchObject({
        ok: true,
        payload: { restartRequired: false },
      });
      expect(
        getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD],
      ).toBeUndefined();
      expect(
        getActivePluginRegistry()?.plugins.find((record) => record.id === "startup-broken"),
      ).toBe(broken);
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      const closing = socket;
      const closed =
        !closing || closing.readyState === closing.CLOSED
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              closing.once("close", () => resolve());
            });
      closing?.close();
      try {
        await server.close({ reason: "startup-error lifecycle cleanup" });
        await closed;
      } finally {
        clearInstanceBindingProbeCoordinators();
        delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      }
    }
  },
);
