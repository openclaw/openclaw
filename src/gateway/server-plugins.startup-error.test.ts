import assert from "node:assert/strict";
import { linkSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
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

it.each(["module-load", "entry-open"] as const)(
  "keeps %s startup errors diagnostic while healthy plugins reload and disable",
  { timeout: 120_000 },
  async (failureKind) => {
    const coordinator = installInstanceBindingProbeCoordinator({ reportReloadSettlement: true });
    const bundledRoot = tempDirs.make("openclaw-startup-error-");
    // External code has captured source generations; bundled JS intentionally
    // keeps process module identity and cannot model a changed candidate file.
    const healthyRoot = tempDirs.make("openclaw-startup-healthy-");
    await writeInstanceBindingProbePlugin(healthyRoot, coordinator.channelName);
    const healthyPlugin = path.join(healthyRoot, "instance-binding-probe");
    const brokenDir = path.join(
      failureKind === "entry-open" ? healthyRoot : bundledRoot,
      "startup-broken",
    );
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
    if (failureKind === "entry-open") {
      const boundary = await import("../infra/boundary-file-read.js");
      const open = boundary.openRootFileSync;
      let injected = false;
      const entryOpen = vi.spyOn(boundary, "openRootFileSync").mockImplementation((options) => {
        if (
          !injected &&
          options.absolutePath === path.join(brokenDir, "index.js") &&
          options.boundaryLabel === "plugin root"
        ) {
          // Discovery has admitted metadata. Change the real inode only during
          // the import boundary check, then leave later metadata reads valid.
          injected = true;
          const alias = path.join(healthyRoot, "entry-alias.js");
          linkSync(options.absolutePath, alias);
          try {
            return open(options);
          } finally {
            unlinkSync(alias);
          }
        }
        return open(options);
      });
      onTestFinished(() => entryOpen.mockRestore());
    }
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
          load: { paths: [healthyPlugin, ...(failureKind === "entry-open" ? [brokenDir] : [])] },
          entries: {
            "startup-broken": { enabled: true },
            "instance-binding-probe": { enabled: true },
          },
        },
      }),
    );
    const recovery = vi.fn(() => ({ status: "emitted" as const }));
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const port = portClaim.port;
    const server = await startTestGatewayServer(portClaim, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      sidecarStartup: "start",
      hotReloadRecovery: recovery,
    });
    let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
    try {
      await server.startupSettled;
      const connected = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      socket = connected;
      await expect
        .poll(async () => (await rpcReq(connected, INSTANCE_BINDING_PROBE_METHOD, {})).payload, {
          timeout: 30_000,
        })
        .toMatchObject({ reloadSettled: true });
      const initial = getActivePluginRegistry();
      assert(initial);
      const broken = initial.plugins.find((record) => record.id === "startup-broken");
      expect(broken).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          failureKind === "entry-open" ? "plugin entry path" : "startup failure remains diagnostic",
        ),
      });
      assert(broken);
      if (failureKind === "entry-open") {
        expect(getPluginInstance(broken)).toBeUndefined();
      }
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

      // Break only B's code; recovery must register captured A code under a fresh owner.
      await fs.writeFile(
        path.join(healthyPlugin, "index.js"),
        'throw new Error("new candidate failure");',
      );
      const rejected = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "activate" } } },
      });
      expect(rejected.error?.message).toContain("new candidate failure");
      expect(rejected.error?.message).not.toContain("startup-broken");
      const recovered = getActivePluginRegistry();
      expect(recovered).not.toBe(current);
      expect(recovered?.plugins.find((record) => record.id === "startup-broken")).toBe(broken);
      const retained = await rpcReq(socket, INSTANCE_BINDING_PROBE_METHOD, {});
      expect(retained.ok, retained.error?.message).toBe(true);
      expect(retained.payload?.registryId).not.toBe(after.payload?.registryId);
      expect(retained.payload).toMatchObject({
        sessionsId: after.payload?.sessionsId,
        placementId: after.payload?.placementId,
      });

      const registrationsBeforeRepair = coordinator.runtimes.length;
      if (failureKind === "entry-open") {
        // Repair the entry, then fail B activation. Reexecuting these current files
        // as C would succeed, concealing that no old runnable source was captured.
        await fs.unlink(path.join(brokenDir, "index.js"));
        await fs.writeFile(
          path.join(brokenDir, "index.js"),
          `module.exports = { id: "startup-broken", register(api) {
            const request = {};
            require("node:diagnostics_channel").channel(${JSON.stringify(coordinator.channelName)}).publish(request);
            const coordinator = request.coordinator;
            coordinator.runtimes.push(api.runtime);
            api.registerGatewayMethod("startupBroken.repaired", ({ respond }) => respond(true, { repaired: true }), { scope: "operator.read" });
            api.registerService({ id: "repaired-startup", start() {
              coordinator.serviceStarts++;
              if (coordinator.serviceStarts === 1) throw new Error("repaired candidate activation failed");
            } });
          } };`,
        );
      }
      const retryBroken = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "startup-broken" }],
      });
      expect(retryBroken).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "activate" } } },
      });
      if (failureKind === "module-load") {
        expect(retryBroken.error?.message).toContain("startup-broken");
      }
      if (failureKind === "entry-open") {
        expect(retryBroken.error?.message).toContain("repaired candidate activation failed");
        expect(coordinator.runtimes).toHaveLength(registrationsBeforeRepair + 1);
        expect(coordinator.serviceStarts).toBe(1);
        expect(
          getActivePluginRegistry()?.gatewayHandlers["startupBroken.repaired"],
        ).toBeUndefined();
      }
      expect(getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD]).toBe(
        recovered?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD],
      );
      expect(
        getActivePluginRegistry()?.plugins.find((record) => record.id === "startup-broken"),
      ).toBe(broken);
      expect(
        getActivePluginRegistry()?.diagnostics.filter(
          (entry) => entry.pluginId === "startup-broken",
        ),
      ).toEqual(diagnostics);

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
