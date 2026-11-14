import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tarEsm from "tar";

const require = createRequire(import.meta.url);
const tar = process.argv.includes("--commonjs") ? require("tar") : tarEsm;
// Dependencies have already observed a writable descriptor during import.
// Protect the host's Buffer before using any archive operation.
Object.defineProperty(Buffer, "concat", { writable: false });
const root = await fs.mkdtemp(path.join(tmpdir(), "archive-runtime-"));
try {
  const payload = Buffer.alloc(192 * 1024);
  let seed = 123456789;
  for (let i = 0; i < payload.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    payload[i] = seed & 255;
  }
  await fs.writeFile(path.join(root, "payload"), payload);
  for (const sync of [true, false]) {
    const file = path.join(root, `${sync}.tgz`);
    await tar.create({ cwd: root, file, gzip: true, portable: true, sync }, ["payload"]);
    const names = [];
    await tar.list({ file, sync, onReadEntry: (entry) => names.push(entry.path) });
    assert.deepEqual(names, ["payload"]);
    const cwd = path.join(root, `out-${sync}`);
    await fs.mkdir(cwd);
    await tar.extract({ file, cwd, sync, strict: true });
    assert.deepEqual(await fs.readFile(path.join(cwd, "payload")), payload);
    assert.equal((await fs.readFile(file))[9], 255);
  }
  const file = path.join(root, "stream.tgz");
  const pack = new tar.Pack({ cwd: root, gzip: true, portable: true });
  const packed = pipeline(pack, createWriteStream(file));
  pack.add("payload");
  pack.end();
  await packed;
  const contents = [];
  const parser = tar.list({ onReadEntry: (entry) => contents.push(entry.concat()) });
  await pipeline(createReadStream(file, { highWaterMark: 4096 }), parser);
  assert.deepEqual(await Promise.all(contents), [payload]);
  await fs.writeFile(path.join(root, "bad.tgz"), Buffer.from([31, 139, 0, 0, 0, 0, 0, 0]));
  assert.throws(() => tar.list({ file: path.join(root, "bad.tgz"), sync: true }));
  await tar.list({ file, strict: true });
  console.log("archive round trip passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
