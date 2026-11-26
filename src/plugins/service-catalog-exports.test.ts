import { describe, expect, it, vi } from "vitest";
import { createDeferredCore as createDeferred } from "../shared/deferred.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginServiceCatalogExports } from "./service-catalog-exports.js";
import type { SessionCatalogProvider } from "./session-catalog.js";

function fixture() {
  const rows = ["shown", "peer", "unknown"].map((threadId) => ({
    threadId,
    sourceHomeId: "native-home",
    name: "source title",
    cwd: "private cwd",
    status: "stored",
    archived: false,
    canContinue: false,
    canArchive: false,
    exportPolicy:
      threadId === "shown"
        ? { origin: "native-local" as const, automatic: true }
        : threadId === "peer"
          ? { origin: "federated" as const, automatic: false }
          : undefined,
  }));
  const list = vi.fn<SessionCatalogProvider["list"]>(async () => [
    {
      hostId: "native",
      label: "owned",
      kind: "gateway",
      connected: true,
      sessions: rows,
    },
  ]);
  const read = vi.fn<SessionCatalogProvider["read"]>(async ({ hostId, threadId }) => ({
    hostId,
    threadId,
    items: [
      {
        type: "userMessage",
        text: "visible",
        sender: { identity: { type: "profile", id: "private-profile" }, label: "private label" },
      },
      { type: "toolCall", text: "private arguments", raw: { data: "private raw" } },
    ],
  }));
  const provider = {
    id: "lab-catalog",
    label: "Lab",
    automaticExportHosts: () => ["native"],
    supportsProcessHomeIsolation: true as const,
    list,
    read,
  };
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push(
    { pluginId: "lab-producer", source: "test", provider },
    { pluginId: "another", source: "test", provider: { ...provider, id: "not-enabled" } },
    { pluginId: "observer", source: "test", provider: { ...provider, id: "self" } },
    {
      pluginId: "unclassified",
      source: "test",
      provider: { ...provider, id: "peer-only", automaticExportHosts: undefined },
    },
  );
  const selected = { sources: ["lab-catalog", "self", "peer-only"] };
  const config = { plugins: { entries: { observer: { enabled: true, config: selected } } } };
  const signal = new AbortController();
  const exports = createPluginServiceCatalogExports({
    pluginId: "observer",
    registry,
    configPath: ["sources"],
    getConfig: () => config,
    assertActive: () => {},
    signal: signal.signal,
  });
  const request = {
    agentId: "main",
    hostId: "native",
    threadId: "shown",
    sourceHomeId: "native-home",
    limit: 10,
  };
  return { registry, provider, rows, read, list, signal, selected, exports, request };
}

describe("service-owned catalog exports", () => {
  it("lists only selected native hosts, grants exact locators, and strips private fields", async () => {
    const f = fixture();
    const catalogs = f.exports.listCatalogs();
    expect(catalogs.map((c) => c.id)).toEqual(["lab-catalog"]);
    const [catalog] = catalogs;
    await expect(catalog!.read(f.request)).rejects.toThrow("Select a listed");
    const hosts = await catalog!.list({});
    expect(hosts[0]?.sessions.map((row) => row.threadId)).toEqual(["shown"]);
    expect(hosts[0]?.sessions[0]).not.toHaveProperty("cwd");
    expect(f.list.mock.calls[0]?.[0].hostIds).toEqual(["native"]);
    expect(await f.list.mock.calls[0]?.[0].listNodes?.()).toEqual({ nodes: [] });
    for (const override of [
      { sourceHomeId: "other" },
      { agentId: "other" },
      { threadId: "peer" },
      { threadId: "unknown" },
    ]) {
      await expect(catalog!.read({ ...f.request, ...override })).rejects.toThrow();
    }
    expect(f.read).not.toHaveBeenCalled();
    const page = await catalog!.read(f.request);
    expect(page.items).toEqual([
      { type: "userMessage", text: "visible", speakerId: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { type: "toolCall" },
    ]);
    expect(f.read.mock.calls[0]?.[0]).toMatchObject(f.request);
    const replacement = f.exports.listCatalogs()[0]!;
    await expect(catalog!.read(f.request)).rejects.toThrow("expired");
    await replacement.list({});
    expect((await replacement.read(f.request)).items[0]?.speakerId).not.toBe(
      page.items[0]?.speakerId,
    );
  });

  it("passes the exact host and native ID to its producer and returns epoch milliseconds", async () => {
    const f = fixture();
    const [catalog] = f.exports.listCatalogs();
    const source = { hostId: "native", threadId: "shown", sourceHomeId: "native-home" };
    f.list.mockImplementation(async (query) => {
      expect(query.search).toBeUndefined();
      expect(query.exportSource).toEqual(source);
      expect(query.hostIds).toEqual(["native"]);
      return [
        {
          hostId: "native",
          label: "Native",
          kind: "gateway",
          connected: true,
          sessions: f.rows.map((row) => ({
            ...row,
            updatedAt: 1800000000,
            recencyAt: 1800000000123,
          })),
        },
      ];
    });
    expect((await catalog!.list({ source }))[0]?.sessions).toMatchObject([
      { threadId: "shown", updatedAt: 1800000000000, recencyAt: 1800000000123 },
    ]);
    await expect(catalog!.read(f.request)).resolves.toMatchObject({ threadId: "shown" });
    expect(await catalog!.list({ source: { ...source, hostId: "peer" } })).toEqual([]);
    expect(f.list).toHaveBeenCalledOnce();
  });

  it("pages currently admitted hosts and replaces the preceding page's grants", async () => {
    const f = fixture();
    let localHosts = ["native", "withdrawn", "other"];
    f.provider.automaticExportHosts = () => localHosts;
    f.list.mockImplementation(async ({ hostIds, cursors }) =>
      [...(hostIds ?? []), "peer"].map((hostId) => {
        const cursor = cursors?.[hostId];
        const terminal = cursor === "opaque/end";
        return {
          hostId,
          label: hostId,
          kind: "gateway",
          connected: true,
          nextCursor: terminal ? undefined : cursor ? "opaque/end" : "opaque/2",
          sessions: terminal ? [] : [{ ...f.rows[0]!, threadId: cursor ? "next" : "shown" }],
        };
      }),
    );
    const catalog = f.exports.listCatalogs()[0]!;
    const [first] = await catalog.list({});
    expect(f.list.mock.calls[0]?.[0]).not.toHaveProperty("cursors");
    expect(first).toMatchObject({ hostId: "native", nextCursor: "opaque/2" });
    const pending = createDeferred<Awaited<ReturnType<SessionCatalogProvider["read"]>>>();
    f.read.mockImplementationOnce(() => pending.promise);
    const reading = catalog.read(f.request);
    localHosts = ["native", "other"];
    const hosts = await catalog.list({
      cursors: { native: first!.nextCursor!, withdrawn: "stale", peer: "unsolicited" },
    });
    expect(f.list.mock.calls[1]?.[0].hostIds).toEqual(["native", "other"]);
    expect(f.list.mock.calls[1]?.[0].cursors).toEqual({ native: "opaque/2" });
    expect(hosts.map(({ hostId, sessions }) => [hostId, sessions[0]?.threadId])).toEqual([
      ["native", "next"],
      ["other", "shown"],
    ]);
    pending.resolve({ ...f.request, items: [] });
    await expect(reading).rejects.toThrow("source changed");
    for (const hostId of ["native", "withdrawn", "peer"]) {
      await expect(catalog.read({ ...f.request, hostId })).rejects.toThrow("Select a listed");
    }
    await expect(catalog.read({ ...f.request, threadId: "next" })).resolves.toMatchObject({
      threadId: "next",
    });
    await expect(
      catalog.list({ source: f.request, cursors: { native: "opaque/2" } }),
    ).rejects.toThrow("exact catalog source");
    expect(f.list).toHaveBeenCalledTimes(2);
    const resumed = f.exports.listCatalogs()[0]!;
    const [terminal] = await resumed.list({ cursors: { native: hosts[0]!.nextCursor! } });
    expect(terminal).toMatchObject({ hostId: "native", nextCursor: undefined, sessions: [] });
    await expect(resumed.read({ ...f.request, threadId: "next" })).rejects.toThrow(
      "Select a listed",
    );
  });

  it.each(["source replaced", "consent removed", "service stopped"] as const)(
    "discards pending bytes if %s",
    async (reason) => {
      const f = fixture();
      const catalog = f.exports.listCatalogs()[0]!;
      await catalog.list({});
      const pending = createDeferred<Awaited<ReturnType<SessionCatalogProvider["read"]>>>();
      f.read.mockImplementationOnce(() => pending.promise);
      const reading = catalog.read(f.request);
      if (reason === "source replaced") {
        f.registry.sessionCatalogs.splice(0, 1);
      }
      if (reason === "consent removed") {
        f.selected.sources = [];
      }
      if (reason === "service stopped") {
        f.signal.abort();
      }
      pending.resolve({
        hostId: "native",
        threadId: "shown",
        items: [{ type: "userMessage", text: "late bytes" }],
      });
      await expect(reading).rejects.toThrow();
    },
  );
});
