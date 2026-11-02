import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import * as loader from "../../plugins/loader.test-fixtures.js";
import * as cache from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { finalizePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { bootstrapOutboundChannelPluginAsync } from "./channel-bootstrap.runtime.js";

afterEach(() => {
  loader.resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(loader.cleanupPluginLoaderFixturesForTest);

function createFixture({ global = false, deferInstall = false } = {}) {
  loader.useNoBundledPlugins();
  const root = loader.makePluginLoaderTempDir();
  const stateDir = path.join(root, "state");
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const id = "bootstrap-lifecycle";
  const events = path.join(root, "events.txt");
  const write = (dir: string, label: string) => {
    loader.writePlugin({
      id,
      dir,
      filename: "index.cjs",
      registration: `
        const fs = require("node:fs");
        const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + "\\n");
        record("registered:${label}");
        api.lifecycle.onDispose(() => record("disposed:${label}"));
        api.registerChannel({ plugin: {
          id: "${id}",
          meta: { id: "${id}", label: "Fixture", selectionLabel: "Fixture", docsPath: "/fixture", blurb: "Fixture" },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
          outbound: {
            deliveryMode: "direct",
            async sendText() { record("sent:${label}"); return { channel: "${id}", messageId: "${label}" }; },
          },
        } });`,
    });
    loader.writePluginMetadata({
      dir,
      id,
      channels: [id],
      packageJson: { name: id, openclaw: { extensions: ["./index.cjs"] } },
    });
  };
  const pluginDir = global ? path.join(stateDir, "extensions", id) : path.join(root, "plugin");
  const plugin = { id, dir: pluginDir, file: path.join(pluginDir, "index.cjs") };
  if (!deferInstall) {
    write(pluginDir, "first");
  }
  const config: OpenClawConfig = {
    plugins: {
      allow: [id],
      ...(global ? {} : { load: { paths: [plugin.file] } }),
      entries: { [id]: { enabled: true } },
      slots: { memory: "none" },
    },
    channels: { [id]: { enabled: true } },
  };
  const params = { channel: id, cfg: config };
  const request = { cfg: config, to: "recipient", text: "hello" };
  return {
    plugin,
    bootstrap: () => bootstrapOutboundChannelPluginAsync(params),
    request,
    send: (registry: PluginRegistry | undefined, messageId = "first") =>
      expect(sender(registry)(request)).resolves.toMatchObject({ messageId }),
    scope: <T>(snapshot: Parameters<typeof withPluginMetadataSnapshotScope>[0], run: () => T) =>
      withPluginMetadataSnapshotScope(snapshot, run, { config, trustConfigIdentity: true }),
    events: () => fs.readFileSync(events, "utf8").trim().split("\n"),
    write,
    root,
  };
}

function sender(registry: PluginRegistry | undefined) {
  return expectDefined(registry?.channels[0]?.plugin.outbound?.sendText, "bootstrapped sender");
}

describe("outbound bootstrap lifetime", () => {
  it("sends through a fresh instance after replacing the plugin cache", async () => {
    const fixture = createFixture();
    await using firstCache = cache.createPluginCache();
    await using nextCache = cache.createPluginCache();
    const first = await cache.withPluginCache(firstCache, fixture.bootstrap);
    const firstSend = sender(first);
    await fixture.send(first);
    await cache.retirePluginCache(firstCache);
    expect(() => firstSend(fixture.request)).toThrow(/reloaded|disabled|retir/);

    await fixture.send(await cache.withPluginCache(nextCache, fixture.bootstrap));
    expect(fixture.events()).toEqual([
      "registered:first",
      "sent:first",
      "disposed:first",
      "registered:first",
      "sent:first",
    ]);
  });

  it("discovers a newly installed sender after metadata invalidation clears an unavailable outcome", async () => {
    const fixture = createFixture({ global: true, deferInstall: true });
    await using lifetime = cache.createPluginCache();
    await cache.withPluginCache(lifetime, async () => {
      expect(await fixture.bootstrap()).toBeUndefined();
      fixture.write(fixture.plugin.dir, "first");
      expect(await fixture.bootstrap()).toBeUndefined();

      clearPluginMetadataLifecycleCaches();

      await fixture.send(await fixture.bootstrap());
    });
    expect(fixture.events()).toEqual(["registered:first", "sent:first"]);
  });

  it("keeps available and empty metadata outcomes separate within one cache", async () => {
    const fixture = createFixture();
    await using lifetime = cache.createPluginCache();
    const { available, empty } = cache.withPluginCache(lifetime, () => ({
      available: finalizePluginMetadataSnapshot(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: fixture.plugin.id,
              rootDir: fixture.plugin.dir,
              source: fixture.plugin.file,
              origin: "config",
              channels: [fixture.plugin.id],
              configSchema: loader.EMPTY_PLUGIN_SCHEMA,
            },
          ],
        }),
      ),
      empty: finalizePluginMetadataSnapshot(createPluginMetadataSnapshotFixture()),
    }));
    await fixture.scope(available, async () => {
      const first = await fixture.bootstrap();
      await fixture.send(first);
      await fixture.scope(empty, async () => {
        expect(await fixture.bootstrap()).toBeUndefined();
        expect(await fixture.bootstrap()).toBeUndefined();
      });
      const restored = await fixture.bootstrap();
      expect(restored).toBe(first);
      await fixture.send(restored);
    });
    expect(fixture.events()).toEqual(["registered:first", "sent:first", "sent:first"]);
  });
});

it("keeps an async bootstrap outcome in its captured state namespace", async () => {
  const fixture = createFixture({ global: true });
  const nextState = path.join(fixture.root, "other-state");
  fixture.write(path.join(nextState, "extensions", fixture.plugin.id), "second");
  await using lifetime = cache.createPluginCache();
  await cache.withPluginCache(lifetime, async () => {
    const pending = fixture.bootstrap();
    vi.stubEnv("OPENCLAW_STATE_DIR", nextState);
    await fixture.send(await pending);
    await fixture.send(await fixture.bootstrap(), "second");
  });
});
