import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps the real deferred publication code available after its package directory is replaced", async () => {
  const root = await fs.realpath(dirs.make("publication-package-swap-"));
  const built = path.join(root, "built");
  await build({
    stdin: {
      contents: `export {prepareOpenClawStateReplayPublication, withOpenClawStateReplayPublication} from "./src/state/openclaw-state-publication.ts";`,
      resolveDir: process.cwd(),
      sourcefile: "publication-entry.ts",
    },
    outdir: built,
    entryNames: "entry",
    chunkNames: "chunk-[hash]",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    target: "node24",
    logLevel: "silent",
  });
  for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
    await fs.copyFile(path.join(process.cwd(), "src/state", schema), path.join(built, schema));
  }
  const driver = path.join(root, "driver.mjs");
  await fs.writeFile(
    driver,
    `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    import {createHash} from 'node:crypto';
    import {DatabaseSync} from 'node:sqlite';
    const [caseRoot, mode] = process.argv.slice(2);
    const current = path.join(caseRoot, 'package');
    const api = await import(pathToFileURL(path.join(current, 'entry.mjs')).href);
    const databasePath = path.join(caseRoot, 'state.sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ("original");'.replace('"original"', "'original'"));
    db.close();
    const digest = async () => createHash('sha256').update(await fs.readFile(databasePath)).digest('hex');
    const before = await digest();
    if (mode !== 'cold') await api.prepareOpenClawStateReplayPublication();
    await fs.rename(current, path.join(caseRoot, 'displaced'));
    await fs.mkdir(current);
    // The previous package has no candidate-hashed chunks. No files are deleted.
    await fs.writeFile(path.join(current, 'package.json'), JSON.stringify({type:'module',version:'previous'}));
    let reads = 0, writes = 0, error;
    try {
      await api.withOpenClawStateReplayPublication({
        databasePath,
        assertCurrent() {if(mode === 'revoked') throw new Error('owner-revoked');},
        async assertWritersStopped() {reads++; throw new Error('writer-drainage-refused');}
      }, async () => {writes++; throw new Error('publication-must-not-run');});
    } catch (caught) {error={message:String(caught),code:caught.code};}
    console.log(JSON.stringify({mode,error,reads,writes,unchanged:before === await digest()}));
  `,
  );
  for (const mode of ["warm", "cold", "revoked"]) {
    const caseRoot = path.join(root, mode);
    const current = path.join(caseRoot, "package");
    await fs.cp(built, current, { recursive: true });
    await fs.symlink(
      path.join(process.cwd(), "node_modules"),
      path.join(current, "node_modules"),
      "junction",
    );
    const result = await runUtf8CommandWithTimeout([process.execPath, driver, caseRoot, mode], {
      timeoutMs: 30_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    });
    expect(result.code, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.unchanged).toBe(true);
    expect(observed.writes).toBe(0);
    if (mode === "cold") {
      expect(observed.error.code).toBe("ERR_MODULE_NOT_FOUND");
      expect(observed.reads).toBe(0);
    } else {
      expect(observed.error.message).toContain(
        mode === "revoked" ? "owner-revoked" : "writer-drainage-refused",
      );
      expect(observed.reads).toBe(mode === "revoked" ? 0 : 1);
    }
  }
});
