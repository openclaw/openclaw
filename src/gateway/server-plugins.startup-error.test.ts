import assert from "node:assert/strict";
import { linkSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  installInstanceBindingProbeCoordinator,
  INSTANCE_BINDING_PROBE_METHOD,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  closePluginGateway,
  configurePluginGateway,
  installInstanceBindingConfigIo,
  startPluginGateway,
  reloadPlugin,
  writeJson,
  type PluginSocket,
} from "./server-plugins.lifecycle.test-support.js";
import { connectWebchatClient, installGatewayTestHooks, rpcReq } from "./test-helpers.server.js";

// Keep hosted catalog transport outside this loader lifecycle proof.
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted" as const,
    entries: [],
  }),
}));

vi.mock("./server-runtime-services.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-runtime-services.js")>()),
  scheduleGatewayPostReadyMaintenance: () => {},
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
    const brokenEntry = path.join(brokenDir, "index.js");
    await fs.mkdir(brokenDir);
    await writeJson(path.join(brokenDir, "package.json"), {
      name: "startup-broken",
      type: "commonjs",
      openclaw: { extensions: ["./index.js"] },
    });
    await writeJson(path.join(brokenDir, "openclaw.plugin.json"), {
      id: "startup-broken",
      activation: { onStartup: true },
      configSchema: { type: "object" },
    });
    await fs.writeFile(brokenEntry, 'throw new Error("startup failure remains diagnostic");');
    if (failureKind === "entry-open") {
      const boundary = await import("../infra/boundary-file-read.js");
      const open = boundary.openRootFileSync;
      let injected = false;
      const entryOpen = vi.spyOn(boundary, "openRootFileSync").mockImplementation((options) => {
        if (
          !injected &&
          options.absolutePath === brokenEntry &&
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
    await writeJson(configurePluginGateway(bundledRoot), {
      plugins: {
        allow: ["startup-broken", "instance-binding-probe"],
        load: { paths: [healthyPlugin, ...(failureKind === "entry-open" ? [brokenDir] : [])] },
        entries: {
          "startup-broken": { enabled: true },
          "instance-binding-probe": { enabled: true },
        },
      },
    });
    const recovery = vi.fn(() => ({ status: "emitted" as const }));
    const { server, port } = await startPluginGateway({ hotReloadRecovery: recovery });
    let socket: PluginSocket | undefined;
    try {
      await server.startupSettled;
      await waitForGatewayStartup(port);
      const connected = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      socket = connected;
      const probe = async () => {
        const result = await rpcReq(connected, INSTANCE_BINDING_PROBE_METHOD, {});
        expect(result.ok, result.error?.message).toBe(true);
        return result.payload;
      };
      const expectHandler = (method: string, handler: unknown) =>
        expect(getActivePluginRegistry()?.gatewayHandlers[method]).toBe(handler);
      const waitForReloadSettlement = () =>
        expect.poll(probe, { timeout: 30_000 }).toMatchObject({ reloadSettled: true });
      await waitForReloadSettlement();
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
      const expectBrokenRetained = () => {
        const registry = getActivePluginRegistry();
        expect(registry?.plugins.find((record) => record.id === "startup-broken")).toBe(broken);
        expect(
          registry?.diagnostics.filter((entry) => entry.pluginId === "startup-broken"),
        ).toEqual(diagnostics);
      };
      const before = await probe();
      const reload = await reloadPlugin(socket);
      expect(reload, reload.error?.message).toMatchObject({
        ok: true,
        payload: { restartRequired: false, runtime: { pluginIds: ["instance-binding-probe"] } },
      });
      const current = getActivePluginRegistry();
      assert(current);
      expect(current).not.toBe(initial);
      expectBrokenRetained();
      const after = await probe();
      expect(after?.registryId).not.toBe(before?.registryId);

      await waitForReloadSettlement();

      // Break only B's code; recovery must register captured A code under a fresh owner.
      await fs.writeFile(
        path.join(healthyPlugin, "index.js"),
        'throw new Error("new candidate failure");',
      );
      const rejected = await reloadPlugin(socket);
      const activationFailure = {
        ok: false,
        error: { details: { runtime: { committed: false, phase: "activate" } } },
      };
      expect(rejected).toMatchObject(activationFailure);
      expect(rejected.error?.message).toContain("new candidate failure");
      expect(rejected.error?.message).not.toContain("startup-broken");
      const recovered = getActivePluginRegistry();
      expect(recovered).not.toBe(current);
      expectBrokenRetained();
      const retained = await probe();
      expect(retained?.registryId).not.toBe(after?.registryId);
      expect(retained).toMatchObject({
        sessionsId: after?.sessionsId,
        placementId: after?.placementId,
      });
      await waitForReloadSettlement();

      const registrationsBeforeRepair = coordinator.runtimes.length;
      if (failureKind === "entry-open") {
        // Repair the entry, then fail B activation. Reexecuting these current files
        // as C would succeed, concealing that no old runnable source was captured.
        await fs.unlink(brokenEntry);
        await fs.writeFile(
          brokenEntry,
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
      const retryBroken = await reloadPlugin(socket, "startup-broken");
      expect(retryBroken).toMatchObject(activationFailure);
      expect(retryBroken.error?.message).toContain(
        failureKind === "module-load" ? "startup-broken" : "repaired candidate activation failed",
      );
      if (failureKind === "entry-open") {
        expect(coordinator.runtimes).toHaveLength(registrationsBeforeRepair + 1);
        expect(coordinator.serviceStarts).toBe(1);
        expectHandler("startupBroken.repaired", undefined);
      }
      expectHandler(
        INSTANCE_BINDING_PROBE_METHOD,
        recovered?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD],
      );
      expectBrokenRetained();

      await waitForReloadSettlement();
      const disabled = await rpcReq(socket, "plugins.setEnabled", {
        pluginId: "instance-binding-probe",
        enabled: false,
      });
      expect(disabled, disabled.error?.message).toMatchObject({
        ok: true,
        payload: { restartRequired: false },
      });
      expectHandler(INSTANCE_BINDING_PROBE_METHOD, undefined);
      expectBrokenRetained();
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      await closePluginGateway(server, socket);
    }
  },
);
