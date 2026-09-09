import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
  const candidatePlugin = path.join(
    candidateBundled,
    kind === "renamed candidate directory" ? "renamed-demo" : "demo",
  );
  const externalSource =
    kind === "external path" || kind === "source symlink escapes bundled directory";
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
    await fs.mkdir(candidateBundled, { recursive: true });
    if (kind === "candidate bundled root escapes package") {
      const externalBundled = path.join(root, "external-bundled");
      await fs.mkdir(externalBundled);
      await fs.rmdir(candidateBundled);
      await fs.symlink(externalBundled, candidateBundled, "junction");
    }
    await writePlugin(sourcePlugin, "demo", "live");
    if (kind === "source checkout alongside built runtime") {
      await fs.mkdir(path.join(liveHost, "src"));
      await fs.writeFile(path.join(liveHost, ".git"), "");
      await fs.writeFile(path.join(liveHost, "pnpm-workspace.yaml"), "packages: []\n");
      await writePlugin(path.join(sourceBundled, "another"), "another", "built live");
    }
    if (kind === "source symlink escapes bundled directory") {
      await fs.symlink(sourcePlugin, livePlugin, "junction");
    } else if (kind === "external path") {
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
    let locator = kind === "external path" ? sourcePlugin : livePlugin;
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
    if (kind === "candidate bundled root escapes package" && process.platform !== "win32") {
      await fs.chmod(candidatePlugin, 0o777);
    }
    const candidateMode =
      kind === "candidate bundled root escapes package"
        ? (await fs.stat(candidatePlugin)).mode
        : undefined;
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
