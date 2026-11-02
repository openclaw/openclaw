import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { StorageRegistry } from "../../storage/provider.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const pluginInspection = vi.hoisted(() => vi.fn());
const loadedRegistry = vi.hoisted(() => vi.fn<() => StorageRegistry | undefined>());
vi.mock("../../plugins/active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: loadedRegistry,
}));
vi.mock("../../plugins/loader.js", () => ({
  acquirePluginRegistryForInspection: pluginInspection,
}));
vi.mock("../../plugins/manifest-contract-runtime.js", () => ({
  resolveManifestContractRuntimePluginResolution: () => ({ pluginIds: ["fixture-storage"] }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => loadedRegistry.mockReset());

function invoke(
  method: "storage.locations.list" | "storage.locations.probe",
  locations: NonNullable<OpenClawConfig["storage"]>["locations"],
  params: Record<string, unknown> = {},
) {
  const config = { storage: { locations } };
  return callGatewayHandler(coreGatewayHandlers, method, params, {
    context: { getRuntimeConfig: () => config },
  });
}

function location(provider: string, settings = {}) {
  return { provider, settings, encryption: "none" as const };
}

describe("storage Gateway methods", () => {
  it("lists sanitized destinations without opening roots or activating providers", async () => {
    const root = path.join(tempDirs.make("openclaw-storage-rpc-"), "missing");
    const open = vi.fn();
    const storageProviders: StorageRegistry["storageProviders"] = new Map();
    const register = (provider: Parameters<typeof storageProviders.set>[1]["provider"]) =>
      storageProviders.set(provider.id, {
        pluginId: "fixture-storage",
        source: "test",
        provider,
      });
    register({
      id: "memory",
      label: "Memory",
      open,
      describeTarget: (settings) =>
        typeof settings.bucket === "string" ? `memory://${settings.bucket}` : undefined,
    });
    register({ id: "opaque", label: "Opaque", open });
    loadedRegistry.mockReturnValue({ storageProviders });
    const respond = await invoke("storage.locations.list", {
      archive: location("memory", { bucket: "example" }),
      local: {
        provider: "filesystem",
        settings: { path: root },
        encryption: {
          passphrase: { source: "env", provider: "default", id: "STORAGE_TEST_KEY" },
        },
      },
      opaque: location("opaque"),
      unavailable: location("unloaded"),
    });
    expect(respond).toEqual({
      ok: true,
      response: {
        locations: [
          {
            name: "archive",
            provider: "memory",
            displayTarget: "memory://example",
            encrypted: false,
          },
          { name: "local", provider: "filesystem", displayTarget: root, encrypted: true },
          { name: "opaque", provider: "opaque", encrypted: false },
          { name: "unavailable", provider: "unloaded", encrypted: false },
        ],
      },
      error: undefined,
    });
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(open).not.toHaveBeenCalled();
    expect(pluginInspection).not.toHaveBeenCalled();
  });

  it.each([
    ["fixture-storage", "error"],
    ["filesystem", "unavailable"],
  ])(
    "probes unavailable %s without creating roots or activating plugins",
    async (provider, state) => {
      const root = path.join(tempDirs.make("openclaw-storage-rpc-"), "missing");
      const respond = await invoke(
        "storage.locations.probe",
        { archive: location(provider, { path: root }) },
        { name: "archive" },
      );
      expect(respond).toMatchObject({ ok: true, response: { state }, error: undefined });
      expect(pluginInspection).not.toHaveBeenCalled();
      await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["storage.locations.list", "storage.locations.probe"] as const)(
    "%s is available with read scope and rejects unknown request properties",
    async (method) => {
      expect([
        authorizeOperatorScopesForMethod(method, ["operator.read"]),
        authorizeOperatorScopesForMethod(method, []),
      ]).toEqual([{ allowed: true }, { allowed: false, missingScope: "operator.read" }]);
      const respond = await invoke(method, {}, { name: "../invalid", unexpected: true });
      expect(respond).toMatchObject({
        ok: false,
        response: undefined,
        error: { code: "INVALID_REQUEST" },
      });
    },
  );
});
