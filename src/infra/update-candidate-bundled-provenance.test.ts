import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as bundledMetadata from "../plugins/bundled-plugin-metadata.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import * as pluginCacheFiles from "../plugins/plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { projectUpdateCandidatePlugins } from "./update-candidate-plugins.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";

async function writePlugin(directory: string, id: string, generation: string) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: `@openclaw/${id}`,
      version: "2026.9.3",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({ id, configSchema: { type: "object" } }),
  );
  await fs.writeFile(
    path.join(directory, "index.js"),
    `export default ${JSON.stringify(generation)};`,
  );
}

it.each([
  { kind: "directory", bundled: true },
  { kind: "source permissions", bundled: true },
  { kind: "symlink", bundled: true },
  { kind: "entrypoint", bundled: true },
  { kind: "renamed candidate directory", bundled: true },
  { kind: "split candidate runtime", bundled: true },
  { kind: "source checkout alongside built runtime", bundled: true },
  { kind: "candidate in-package fallback", bundled: true },
  { kind: "candidate escaping fallback", bundled: false },
  { kind: "candidate escaping fallback with external install", bundled: false },
  { kind: "external path", bundled: false },
  { kind: "source symlink escapes bundled directory", bundled: false },
  { kind: "candidate symlink escapes bundled directory", bundled: false },
  { kind: "candidate bundled root escapes package", bundled: false },
  { kind: "missing candidate ID", bundled: false },
  { kind: "mismatched candidate ID", bundled: false },
])("preserves candidate plugin provenance: $kind", async ({ kind, bundled }) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-provenance-")));
  const sourceState = path.join(root, "source-state");
  const liveHost = path.join(root, "live-host");
  const candidateHost = path.join(root, "candidate-host");
  const liveBundled = path.join(liveHost, "extensions");
  const livePlugin = path.join(liveBundled, "demo");
  const sourceBundled =
    kind === "source checkout alongside built runtime"
      ? path.join(liveHost, "dist", "extensions")
      : liveBundled;
  const candidateBundled = path.join(
    candidateHost,
    kind === "split candidate runtime" ? "dist-runtime" : "dist",
    "extensions",
  );
  const candidateFallback = kind.startsWith("candidate ") && kind.includes("fallback");
  const escapingFallback = kind.startsWith("candidate escaping fallback");
  const candidatePlugin = path.join(
    candidateFallback ? path.join(candidateHost, "extensions") : candidateBundled,
    kind === "renamed candidate directory" ? "renamed-demo" : "demo",
  );
  const externalInstall =
    kind === "external path" || kind === "candidate escaping fallback with external install";
  const externalSource = externalInstall || kind === "source symlink escapes bundled directory";
  const sourcePlugin = externalSource ? path.join(root, "external", "demo") : livePlugin;
  const shared = path.join(sourceState, "state", "openclaw.sqlite");
  let cleanupRehearsal: (() => Promise<void>) | undefined;
  try {
    for (const host of [liveHost, candidateHost]) {
      await fs.mkdir(host, { recursive: true });
      await fs.writeFile(
        path.join(host, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.3", type: "module" }),
      );
    }
    await fs.mkdir(liveBundled, { recursive: true });
    await fs.mkdir(path.join(liveHost, "src"));
    await fs.writeFile(path.join(liveHost, "pnpm-workspace.yaml"), "packages: []\n");
    await fs.mkdir(candidateBundled, { recursive: true });
    if (candidateFallback) {
      await fs.mkdir(path.join(candidateHost, "src"));
      await fs.writeFile(path.join(candidateHost, ".git"), "");
      await fs.writeFile(path.join(candidateHost, "pnpm-workspace.yaml"), "packages: []\n");
      await writePlugin(path.join(candidateBundled, "another"), "another", "built candidate");
      if (escapingFallback) {
        const externalFallback = path.join(root, "external-fallback");
        await fs.mkdir(externalFallback);
        await fs.symlink(externalFallback, path.dirname(candidatePlugin), "junction");
      }
    }
    if (kind === "candidate bundled root escapes package") {
      const externalBundled = path.join(root, "external-bundled");
      await fs.mkdir(externalBundled);
      await fs.rmdir(candidateBundled);
      await fs.symlink(externalBundled, candidateBundled, "junction");
    }
    await writePlugin(sourcePlugin, "demo", "live");
    if (kind === "source checkout alongside built runtime") {
      await fs.writeFile(path.join(liveHost, ".git"), "");
      await writePlugin(path.join(sourceBundled, "another"), "another", "built live");
    }
    if (kind === "source symlink escapes bundled directory") {
      await fs.symlink(sourcePlugin, livePlugin, "junction");
    } else if (externalInstall) {
      await writePlugin(livePlugin, "demo", "bundled live");
    }
    if (kind === "split candidate runtime") {
      await writePlugin(path.join(candidateHost, "dist", "extensions", "demo"), "demo", "unused");
    }
    if (kind === "candidate symlink escapes bundled directory") {
      const externalCandidate = path.join(root, "external-candidate", "demo");
      await writePlugin(externalCandidate, "demo", "candidate");
      await fs.symlink(externalCandidate, candidatePlugin, "junction");
    } else if (kind !== "missing candidate ID") {
      await writePlugin(
        candidatePlugin,
        kind === "mismatched candidate ID" ? "other" : "demo",
        "candidate",
      );
    }
    let locator = externalInstall ? sourcePlugin : livePlugin;
    if (kind === "symlink") {
      locator = path.join(root, "demo-alias");
      await fs.symlink(livePlugin, locator, "junction");
    } else if (kind === "entrypoint") {
      locator = path.join(livePlugin, "index.js");
    }
    const installRecords = {
      demo: { source: "path", installPath: locator, sourcePath: locator },
    } satisfies Record<string, PluginInstallRecord>;
    const config: OpenClawConfig = {
      plugins: {
        installs: installRecords,
        ...(kind === "entrypoint" ? { load: { paths: [locator] } } : {}),
      },
    };
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: sourceState } }).db;
    registry
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run("plugins.installedIndex", JSON.stringify({ revision: 1, index: { installRecords } }), 1);
    closeOpenClawStateDatabaseByPath(shared);
    const liveDatabase = await fs.readFile(shared);
    const liveEntry = await fs.readFile(path.join(sourcePlugin, "index.js"));
    const inspect = (stateDir: string, bundledRoot: string, inspectedConfig: OpenClawConfig) =>
      withPluginCache(createPluginCache(), () =>
        loadPluginManifestRegistryCore({
          env: {
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          },
          config: inspectedConfig,
        }).plugins.find((plugin) => plugin.id === "demo"),
      );
    expect(inspect(sourceState, sourceBundled, config)).toMatchObject({
      origin: externalSource ? "global" : "bundled",
      trust: { reason: externalSource ? "origin-path" : "bundled", installSource: "path" },
    });
    if (kind === "source permissions" && process.platform !== "win32") {
      await fs.chmod(sourcePlugin, 0o777);
      await fs.chmod(path.join(sourcePlugin, "index.js"), 0o666);
    }
    const sourceModes = await Promise.all(
      [sourcePlugin, path.join(sourcePlugin, "index.js")].map(
        async (file) => (await fs.stat(file)).mode,
      ),
    );
    const outsideCandidate = kind === "candidate bundled root escapes package" || escapingFallback;
    if (outsideCandidate && process.platform !== "win32") {
      await fs.chmod(candidatePlugin, 0o777);
    }
    const candidateMode = outsideCandidate ? (await fs.stat(candidatePlugin)).mode : undefined;
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      candidateRoot: candidateHost,
      stateDir: sourceState,
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: sourceBundled,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });
    cleanupRehearsal = rehearsal.cleanup;
    if (candidateMode !== undefined) {
      expect((await fs.stat(candidatePlugin)).mode).toBe(candidateMode);
    }
    const copiedConfig: OpenClawConfig = JSON.parse(
      await fs.readFile(rehearsal.configPath, "utf8"),
    );
    const candidate = inspect(rehearsal.stateDir, candidateBundled, {});
    expect(candidate).toMatchObject({
      origin: bundled ? "bundled" : "global",
      trust: { reason: bundled ? "bundled" : "origin-path", installSource: "path" },
    });
    const selectedEntry = candidate?.source ?? "";
    expect(inspect(rehearsal.stateDir, candidateBundled, copiedConfig)?.source).toBe(selectedEntry);
    expect(await fs.readFile(selectedEntry, "utf8")).toBe(
      `export default ${JSON.stringify(bundled ? "candidate" : "live")};`,
    );
    if (bundled) {
      expect(selectedEntry).toBe(path.join(candidatePlugin, "index.js"));
    } else {
      expect(selectedEntry.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
    }
    expect(await fs.readFile(shared)).toEqual(liveDatabase);
    expect(await fs.readFile(path.join(sourcePlugin, "index.js"))).toEqual(liveEntry);
    expect(config.plugins?.installs?.demo?.sourcePath).toBe(locator);
    expect(
      await Promise.all(
        [sourcePlugin, path.join(sourcePlugin, "index.js")].map(
          async (file) => (await fs.stat(file)).mode,
        ),
      ),
    ).toEqual(sourceModes);
    expect(await rehearsal.changedConfigKeys()).toEqual([]);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await cleanupRehearsal?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(["source", "candidate"])("does not enumerate an outside %s fallback", async (side) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-fallback-")));
  const sourceHost = path.join(root, "source-host");
  const candidateHost = path.join(root, "candidate-host");
  const external = path.join(root, "outside");
  const fallback = path.join(side === "source" ? sourceHost : candidateHost, "extensions");
  const installed = path.join(external, "demo");
  const metadata = vi.spyOn(bundledMetadata, "listBundledPluginMetadata");
  const directoryReads = vi.spyOn(pluginCacheFiles, "readPluginCacheDirectory");
  try {
    for (const host of [sourceHost, candidateHost]) {
      await fs.mkdir(path.join(host, "src"), { recursive: true });
      await fs.writeFile(path.join(host, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(host, ".git"), "");
      await fs.writeFile(path.join(host, "pnpm-workspace.yaml"), "packages: []\n");
      await writePlugin(path.join(host, "dist", "extensions", "another"), "another", "bundled");
    }
    await writePlugin(installed, "demo", "external");
    await fs.symlink(external, fallback, "junction");
    const projected = await withPluginCache(createPluginCache(), () =>
      projectUpdateCandidatePlugins({
        stateDir: path.join(root, "state"),
        targetStateDir: path.join(root, "copy"),
        candidateRoot: candidateHost,
        config: { plugins: { installs: { demo: { source: "path", installPath: installed } } } },
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sourceHost, "dist", "extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
      }),
    );
    expect(directoryReads.mock.calls.map(([directory]) => directory)).not.toContain(fallback);
    expect(metadata.mock.calls.map(([options]) => options?.scanDir)).not.toContain(fallback);
    expect(await fs.readFile(path.join(projected[installed]!, "index.js"), "utf8")).toBe(
      'export default "external";',
    );
  } finally {
    directoryReads.mockRestore();
    metadata.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "redirects multi-entry bundles with missing candidate entry=%s",
  async (missing) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-entries-")));
    const sourceHost = path.join(root, "source-host");
    const candidateHost = path.join(root, "candidate-host");
    const sourcePlugin = path.join(sourceHost, "extensions", "demo");
    const candidatePlugin = path.join(candidateHost, "dist", "extensions", "demo");
    const stateDir = path.join(root, "state");
    const entries = ["first", "second", "third"];
    const candidateEntries = missing ? entries.slice(0, 2) : entries;
    let cleanup: (() => Promise<void>) | undefined;
    try {
      for (const host of [sourceHost, candidateHost]) {
        await fs.mkdir(host, { recursive: true });
        await fs.writeFile(
          path.join(host, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
        );
      }
      await fs.mkdir(path.join(sourceHost, "src"));
      await fs.writeFile(path.join(sourceHost, "pnpm-workspace.yaml"), "packages: []\n");
      for (const [directory, names, generation] of [
        [sourcePlugin, entries, "live"],
        [candidatePlugin, candidateEntries, "candidate"],
      ] as const) {
        await writePlugin(directory, "demo", generation);
        await fs.writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: "@openclaw/different-package-name",
            version: "2026.9.3",
            type: "module",
            openclaw: { extensions: names.map((name) => `./${name}.js`) },
          }),
        );
        for (const name of names) {
          await fs.writeFile(
            path.join(directory, `${name}.js`),
            `export default ${JSON.stringify(`${generation}-${name}`)};`,
          );
        }
      }
      const installRecords: Record<string, PluginInstallRecord> = missing
        ? Object.fromEntries(
            entries.map((name) => [
              `demo/${name}`,
              {
                source: "path",
                installPath: path.join(sourcePlugin, `${name}.js`),
              },
            ]),
          )
        : { demo: { source: "path", installPath: sourcePlugin } };
      const config: OpenClawConfig = {
        plugins: {
          installs: installRecords,
          ...(!missing
            ? { load: { paths: entries.map((name) => path.join(sourcePlugin, `${name}.js`)) } }
            : {}),
        },
      };
      const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).db;
      registry
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(
          "plugins.installedIndex",
          JSON.stringify({ revision: 1, index: { installRecords } }),
          1,
        );
      closeOpenClawStateDatabaseByPath(path.join(stateDir, "state", "openclaw.sqlite"));
      const rehearsal = await prepareUpdateCandidateRehearsal({
        config,
        stateDir,
        candidateRoot: candidateHost,
        env: {
          ...process.env,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(sourcePlugin),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        },
      });
      cleanup = rehearsal.cleanup;
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const projectedPaths = entries.map((name, index) =>
        missing
          ? copied.plugins?.installs?.[`demo/${name}`]?.installPath
          : copied.plugins?.load?.paths?.[index],
      );
      for (const [index, name] of candidateEntries.entries()) {
        expect(projectedPaths[index]).toBe(path.join(candidatePlugin, `${name}.js`));
      }
      if (!missing) {
        expect(copied.plugins?.installs?.demo?.installPath).toBe(candidatePlugin);
      }
      const discovered = withPluginCache(createPluginCache(), () =>
        loadPluginManifestRegistryCore({
          config: copied,
          env: {
            OPENCLAW_STATE_DIR: rehearsal.stateDir,
            OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(candidatePlugin),
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          },
        }),
      ).plugins;
      for (const name of candidateEntries) {
        expect(discovered.find((plugin) => plugin.id === `demo/${name}`)).toMatchObject({
          origin: "bundled",
          source: path.join(candidatePlugin, `${name}.js`),
          trust: { reason: "bundled" },
        });
      }
      if (missing) {
        const retained = projectedPaths[2] ?? "";
        expect(retained.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
        expect(await fs.readFile(retained, "utf8")).toBe('export default "live-third";');
        expect(discovered.find((plugin) => plugin.source === retained)).toMatchObject({
          origin: "global",
          trust: { reason: "origin-path" },
        });
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      await cleanup?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
