import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Observe native entry bytes in the owned Gateway; diagnostic logs are redacted. */
export async function createQaPluginEntryObservation(params: { directory: string; entry: string }) {
  const receipts = path.join(params.directory, "plugin-entry");
  await fs.mkdir(receipts, { mode: 0o700 });
  const preload = path.join(receipts, "observe.mjs");
  const entryUrl = pathToFileURL(params.entry).href;
  await fs.writeFile(
    preload,
    `import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const directory = ${JSON.stringify(receipts)};
const pluginDirectory = ${JSON.stringify(path.basename(path.dirname(params.entry)))};
const entryName = ${JSON.stringify(path.basename(params.entry))};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:")) return loaded;
    const file = fileURLToPath(url);
    if (path.basename(file) !== entryName || path.basename(path.dirname(file)) !== pluginDirectory) return loaded;
    if (loaded.source == null) throw new Error("Native plugin entry source was unavailable");
    const source = loaded.source instanceof ArrayBuffer ? new Uint8Array(loaded.source) : loaded.source;
    const sha256 = createHash("sha256").update(source).digest("hex");
    appendFileSync(path.join(directory, String(process.pid) + ".jsonl"), JSON.stringify({ pid: process.pid, url, sha256 }) + "\\n", { mode: 0o600 });
    return loaded;
  },
});
`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    preloadUrl: pathToFileURL(preload).href,
    async verify(pid: number | null, sha256: string) {
      assert.ok(pid !== null, "The owned Gateway must have a process identity");
      const rows = (await fs.readFile(path.join(receipts, `${pid}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.ok(rows.length > 0, "The owned Gateway did not load its native plugin entry");
      for (const line of rows) {
        const observed: unknown = JSON.parse(line);
        assert.deepEqual(observed, { pid, url: entryUrl, sha256 });
      }
    },
  };
}
