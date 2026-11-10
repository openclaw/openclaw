import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { generateSqliteSchemaCatalogs } from "../../scripts/lib/sqlite-schema-generation.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const PROBE_SQL = "CREATE TABLE probe_entries (id TEXT NOT NULL PRIMARY KEY, label TEXT) STRICT;";
const PROBE_HASH = createHash("sha256").update(PROBE_SQL).digest("hex");

async function writeProbeCatalogs(root: string): Promise<void> {
  const files = await generateSqliteSchemaCatalogs(
    [{ id: "probe", store: "probe", sql: PROBE_SQL }],
    process.cwd(),
  );
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
}

function runReaderPhase(root: string, phase: "retired" | "intact"): unknown {
  const script = `import { readSqliteProbeCatalog, readSqliteProbeFingerprint } from ${JSON.stringify(
    path.join(root, "sqlite-probe-catalogs.ts"),
  )};
const hash = ${JSON.stringify(PROBE_HASH)};
const catalog = readSqliteProbeCatalog(hash);
if (process.env.CATALOG_PHASE === "intact") {
  if (catalog === undefined) throw new Error("expected the intact catalog to resolve");
  if (catalog.tables[0]?.name !== "probe_entries") throw new Error("unexpected catalog tables");
} else {
  if (catalog !== undefined) throw new Error("expected the retired catalog to fall through");
}
if (readSqliteProbeFingerprint(hash) === undefined) {
  throw new Error("fingerprint must still resolve after the catalog retires");
}
console.log("ok");
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CATALOG_PHASE: phase },
    cwd: root,
  });
}

it("falls through to native schema discovery when a newer build retired the catalog entry", async () => {
  const root = fs.realpathSync(createTempDir("sqlite-catalog-cross-generation-"));
  await writeProbeCatalogs(root);
  runReaderPhase(root, "intact");

  // Simulate the newer build's asset: same fingerprints, catalog entry retired.
  const assetPath = path.join(root, "sqlite-probe-catalogs.json");
  const asset = JSON.parse(fs.readFileSync(assetPath, "utf8")) as {
    catalogs: Record<string, unknown>;
  };
  delete asset.catalogs[PROBE_HASH];
  fs.writeFileSync(assetPath, JSON.stringify(asset));

  expect(() => runReaderPhase(root, "retired")).not.toThrow();
});
