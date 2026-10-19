import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { callGateway, open } = vi.hoisted(() => ({ callGateway: vi.fn(), open: vi.fn() }));
const manifest = vi.hoisted(() => ({
  id: "knowledge",
  origin: "config",
  channels: [],
  configContracts: { secretInputs: { paths: [{ path: "credential" }] } },
}));
// mock-isolation: keep Gateway I/O synthetic and never contact an operator instance.
vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: () => ({ plugins: [manifest] }),
}));
vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({ plugins: [manifest], diagnostics: [] }),
}));
vi.mock("../config/io.plugin-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.plugin-metadata.js")>()),
  resolveConfigWidePluginManifestRegistry: () => ({ plugins: [manifest], diagnostics: [] }),
}));
vi.mock("../plugins/memory-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/memory-runtime.js")>()),
  resolveActiveMemoryBackendConfig: () => ({
    backend: "provider-runtime",
    providerId: "knowledge",
  }),
  getActiveMemoryProviderCore: open,
}));

import { collectMemorySearchHealthFindings } from "./doctor-memory-search.js";

beforeEach(() => {
  callGateway.mockReset();
  open.mockReset().mockResolvedValue({
    provider: { health: async () => ({ status: "ready" }), close: async () => {} },
  });
});
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "resolves plugin credentials before targeted Doctor lint (available=%s)",
  async (available) => {
    const cfg: OpenClawConfig = {
      memory: { search: { provider: "none" } },
      plugins: {
        slots: { memory: "knowledge" },
        entries: {
          knowledge: {
            enabled: true,
            config: {
              credential: { source: "exec", provider: "fixture", id: "token" },
            },
          },
        },
      },
    };
    callGateway.mockResolvedValue({
      assignments: available
        ? [
            {
              pathSegments: ["plugins", "entries", "knowledge", "config", "credential"],
              value: "fixture-resolved-token",
              path: "plugins.entries.knowledge.config.credential",
            },
          ]
        : [],
      diagnostics: [],
      inactiveRefPaths: [],
    });

    const findings = await collectMemorySearchHealthFindings({
      cfg,
      mode: "lint",
      allowExecSecretRefs: true,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    if (available) {
      expect(findings).toEqual([]);
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.objectContaining({
            plugins: expect.objectContaining({
              entries: {
                knowledge: { enabled: true, config: { credential: "fixture-resolved-token" } },
              },
            }),
          }),
        }),
      );
    } else {
      expect(open).not.toHaveBeenCalled();
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/memory-search",
          severity: "warning",
          path: "plugins.slots.memory",
          message: expect.stringContaining("unavailable"),
        }),
      ]);
    }
  },
);
