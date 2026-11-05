import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isMainThread,
  parentPort,
  SHARE_ENV,
  threadId,
  Worker,
  workerData,
} from "node:worker_threads";

if (isMainThread) {
  const [profiler, output, mode] = process.argv.slice(2);
  const addon = path.join(output, "allocator.cjs");
  // This fixture exercises census ownership only; allocator sampling must not run.
  fs.writeFileSync(addon, "module.exports = {};\n");
  process.env.OPENCLAW_NATIVE_PROFILE_DIR = output;
  process.env.OPENCLAW_NATIVE_PROFILE_ADDON = addon;
  await import(pathToFileURL(profiler).href);
  const census = () =>
    fs
      .readdirSync(output)
      .filter((file) => file.endsWith(".ready.json"))
      .sort();
  const sibling = new Worker(new URL(import.meta.url), { workerData: { depth: 0 }, execArgv: [] });
  const parent = new Worker(new URL(import.meta.url), { workerData: { depth: 2 }, execArgv: [] });
  try {
    const [[siblingIds], [subtreeIds]] = await Promise.all([
      once(sibling, "message"),
      once(parent, "message"),
    ]);
    const before = census();
    assert.equal(before.length, 5);
    if (mode === "natural") {
      const exited = once(parent, "exit");
      parent.postMessage("exit");
      assert.deepEqual(await exited, [0]);
    } else {
      await parent.terminate();
    }
    const after = census();
    const expected = [0, ...siblingIds].map((id) => `${process.pid}-${id}.ready.json`).sort();
    assert.deepEqual(after, expected, `terminated subtree ${subtreeIds} remains in census`);
    const reply = once(sibling, "message");
    sibling.postMessage("ping");
    assert.deepEqual(await reply, ["pong"]);
    console.log(
      JSON.stringify({ mode, before: before.length, after: after.length, siblingResponsive: true }),
    );
  } finally {
    await Promise.all([parent.terminate(), sibling.terminate()]);
  }
} else {
  const child =
    workerData.depth > 0
      ? new Worker(new URL(import.meta.url), {
          workerData: { depth: workerData.depth - 1 },
          execArgv: [],
          env: workerData.depth === 2 ? SHARE_ENV : {},
        })
      : undefined;
  const descendants = child ? (await once(child, "message"))[0] : [];
  parentPort.on("message", (message) => {
    if (message === "exit") {
      child?.unref();
      parentPort.close();
    } else {
      parentPort.postMessage("pong");
    }
  });
  parentPort.postMessage([threadId, ...descendants]);
}
