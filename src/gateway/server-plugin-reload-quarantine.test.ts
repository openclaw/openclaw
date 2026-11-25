import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  findActiveDegradedPlugin,
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { reverifyReloadedPluginPayloads } from "./server-plugin-reload-quarantine.js";

it("rechecks the missing peer and clears only the repaired reload target", async () => {
  using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "reload-peer-"));
  const plugin = (id: string) => ({ id, rootDir: path.join(dir.path, id) });
  const target = plugin("target");
  const bystander = plugin("bystander");
  const plugins = [target, bystander];
  const metadata = createPluginMetadataSnapshotFixture({ plugins });
  const installRecords = Object.fromEntries(
    plugins.map(({ id, rootDir }) => [id, { source: "git" as const, installPath: rootDir }]),
  );
  const previous = listActiveDegradedPlugins();
  onTestFinished(() => setActiveDegradedPlugins(previous));
  setActiveDegradedPlugins(
    buildDegradedPluginsFromVerificationFailures(
      plugins.map(({ id, rootDir }) => ({
        pluginId: id,
        installPath: rootDir,
        reason: "missing-package-json",
        detail: "missing at startup",
      })),
    ),
  );
  writeJsonFile(path.join(target.rootDir, "package.json"), { peerDependencies: { openclaw: "*" } });
  writeJsonFile(path.join(bystander.rootDir, "package.json"), {});
  const reload = () =>
    reverifyReloadedPluginPayloads(new Set([target.id]), {
      ...metadata,
      index: { ...metadata.index, installRecords },
    });

  await reload();
  expect(findActiveDegradedPlugin(target.id)?.diagnostic.reason).toBe("missing-openclaw-peer-link");
  const modules = path.join(target.rootDir, "node_modules");
  fs.mkdirSync(modules);
  fs.symlinkSync(process.cwd(), path.join(modules, "openclaw"), "junction");
  await reload();
  expect(listActiveDegradedPlugins().map((entry) => entry.pluginId)).toEqual([bystander.id]);
});
