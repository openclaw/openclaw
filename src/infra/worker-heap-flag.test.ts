import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const factoryUrl = new URL("./worker-cpu.ts", import.meta.url).href;
const preload = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
const probe = `
  import { getHeapStatistics } from "node:v8";
  import { once } from "node:events";
  const before = getHeapStatistics().heap_size_limit;
  const { createCpuTrackedWorker } = await import(${JSON.stringify(factoryUrl)});
  const worker = createCpuTrackedWorker(
    'require("node:worker_threads").parentPort.postMessage(require("node:v8").getHeapStatistics().heap_size_limit)',
    { eval: true, execArgv: [], env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } },
  );
  const [limit] = await once(worker, "message");
  await worker.terminate();
  console.log([before, getHeapStatistics().heap_size_limit, limit].join(","));
`;

function measure(flags: string[], nodeOptions = "") {
  return execFileSync(
    process.execPath,
    [...flags, "--import", preload, "--input-type=module", "-e", probe],
    {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      encoding: "utf8",
    },
  )
    .trim()
    .split(",")
    .map(Number);
}

describe.skipIf(Boolean(process.versions.bun))("worker heap limits", () => {
  it.each([
    ["argv", ["--max-old-space-size=1024"], ""],
    ["environment", [], "--max-old-space-size=1024"],
    ["total heap", ["--max-heap-size=1024"], ""],
    ["percentage", ["--max-old-space-size-percentage=50"], ""],
    ["underscore spelling", ["--max_old_space_size=1024"], ""],
  ])(
    "enforces worker limits with %s while preserving the main heap",
    (_name, flags, nodeOptions) => {
      const [before, after, worker] = measure(flags, nodeOptions);
      expect(after).toBe(before);
      expect(worker).toBeGreaterThanOrEqual(128 * 1024 * 1024);
      expect(worker).toBeLessThan(512 * 1024 * 1024);
    },
  );

  it.each(["--freeze-flags-after-init", "--abort-on-contradictory-flags"])(
    "keeps the process alive with %s",
    (flag) => {
      const [before, after, worker] = measure(["--max-old-space-size=1024", flag]);
      expect(after).toBe(before);
      expect(worker).toBe(before);
    },
  );
});
