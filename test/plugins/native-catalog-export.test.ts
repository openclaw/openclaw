import { afterEach, assert, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createPluginServiceCatalogExports } from "../../src/plugins/service-catalog-exports.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createNativeCatalogTestRegistry,
  createNativeExportFixture,
} from "./native-catalog-export.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each(["claude", "pi"] as const)(
  "grants and reads the exact %s source beyond the first search page",
  async (id) => {
    const source = await createNativeExportFixture(tempDirs.make("catalog-export-"), id);
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: { entries: { beam: { enabled: true, config: { mirror: { catalogs: [id] } } } } },
    };
    setRuntimeConfigSnapshot(config);
    const { registry } = createNativeCatalogTestRegistry(config);
    const [catalog] = createPluginServiceCatalogExports({
      pluginId: "beam",
      configPath: ["mirror", "catalogs"],
      registry,
      signal: new AbortController().signal,
      assertActive: () => {},
      getConfig: () => config,
    }).listCatalogs();
    assert(catalog);
    const provider = registry.sessionCatalogs.find((entry) => entry.provider.id === id)?.provider;
    assert(provider);
    const [fuzzy] = await provider.list({
      agentId: "main",
      hostIds: [source.hostId],
      search: source.threadId,
      limitPerHost: 100,
    });
    expect(fuzzy?.sessions).toHaveLength(100);
    expect(fuzzy?.sessions.some((row) => row.threadId === source.threadId)).toBe(false);
    const [host] = await catalog.list({ source, limitPerHost: 1 });
    expect(host?.sessions.map((row) => [row.threadId, row.sourceHomeId])).toEqual([
      [source.threadId, source.sourceHomeId],
    ]);
    expect(host?.nextCursor).toBeUndefined();
    const read = { ...source, limit: 1 };
    expect((await catalog.read(read)).items).toMatchObject([
      { type: "userMessage", text: "visible selected message" },
    ]);
    const replacement = await createNativeExportFixture(tempDirs.make("catalog-export-"), id, 0);
    expect(replacement.sourceHomeId).not.toBe(source.sourceHomeId);
    expect((await catalog.list({ source })).flatMap((listed) => listed.sessions)).toEqual([]);
    await expect(catalog.read(read)).rejects.toThrow("Select a listed local source");
    expect(
      (await catalog.list({ source: replacement })).flatMap((listed) => listed.sessions),
    ).toHaveLength(1);
  },
);
