import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listPluginDoctorStateMigrationEntries } from "./doctor-contract-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("retains direct dependency resource reads for dedicated Doctor callbacks", async () => {
  const rootDir = fs.realpathSync(dirs.make("doctor-dependency-resource-"));
  const write = (name: string, body: string) => {
    const filename = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, body);
    return filename;
  };
  write(
    "package.json",
    JSON.stringify({ type: "module", dependencies: { "data-package": "1.0.0" } }),
  );
  write(
    "node_modules/data-package/package.json",
    JSON.stringify({ name: "data-package", type: "module", main: "index.mjs" }),
  );
  write(
    "node_modules/data-package/index.mjs",
    "throw new Error('resource access must not execute the dependency');",
  );
  write("node_modules/data-package/schema.json", '{"version":"captured-before"}');
  const source = write(
    "doctor-contract-api.mjs",
    `import { readFileSync } from 'node:fs';
    export const stateMigrations = [{
      id: 'resource-state', label: 'Dependency resource',
      detectLegacyState() {
        return { preview: [readFileSync(new URL('./node_modules/data-package/schema.json', import.meta.url), 'utf8')] };
      },
      migrateLegacyState() { return { changes: [], warnings: [] }; },
    }];`,
  );
  const record = createPluginManifestRecordFixture({
    id: "resource-fixture",
    rootDir,
    source,
    origin: "config",
    doctorContract: { stateMigrations: [{ id: "resource-state" }] },
  });
  await using cache = createPluginCache();
  const entries = withPluginCache(cache, () =>
    listPluginDoctorStateMigrationEntries({
      manifestRegistry: { plugins: [record], diagnostics: [] },
    }),
  );
  const entry = expectDefined(entries[0], "dedicated Doctor migration");
  write("node_modules/data-package/schema.json", '{"version":"installed-after"}');
  const input = {
    config: {},
    env: {},
    stateDir: rootDir,
    oauthDir: rootDir,
    context: {
      openPluginStateKeyedStore() {
        throw new Error("fixture must not open state");
      },
    },
  };
  expect(await entry.migration.detectLegacyState(input)).toEqual({
    preview: ['{"version":"captured-before"}'],
  });
});
