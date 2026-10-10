import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { inspectSelfAndAncestorPidsSync } from "./restart-stale-pids.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";

it.skipIf(!["darwin", "linux", "freebsd", "win32"].includes(process.platform))(
  "protects real ancestors and validates Darwin parent leases on the main thread and a Worker",
  async () => {
    const parentPid = process.ppid;
    const parentStart =
      process.platform === "darwin"
        ? String(
            Math.floor(
              Date.parse(
                `${execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(parentPid)], {
                  encoding: "utf8",
                  env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
                }).trim()} UTC`,
              ) / 1000,
            ),
          )
        : null;
    const ancestry = inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
    expect(ancestry.pids.has(process.pid)).toBe(true);
    expect(ancestry.pids.has(parentPid)).toBe(true);
    if (parentStart !== null) {
      expect(
        createManagedHandoffProcessIdentityReader({ env: {} }).validateDarwinAncestorProcesses(
          parentPid,
          (pids, current) =>
            pids.has(parentPid) && current({ pid: parentPid, startIdentity: parentStart }),
        ),
      ).toBe(true);
    }
    const worker = new Worker(
      new URL(
        `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from "node:worker_threads";
      import { inspectSelfAndAncestorPidsSync } from ${JSON.stringify(new URL("./restart-stale-pids.ts", import.meta.url).href)};
      import { createManagedHandoffProcessIdentityReader } from ${JSON.stringify(new URL("./update-managed-service-handoff-process.ts", import.meta.url).href)};
      const ancestry = inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
      const current = ${JSON.stringify(parentStart)} === null ? null : createManagedHandoffProcessIdentityReader({ env: {} }).validateDarwinAncestorProcesses(${parentPid},
        (pids, matches) => pids.has(${parentPid}) && matches({ pid: ${parentPid}, startIdentity: ${JSON.stringify(parentStart)} }));
      parentPort.postMessage({ self: ancestry.pids.has(process.pid), parent: ancestry.pids.has(${parentPid}), current });
    `)}`,
      ),
      { execArgv: ["--import", new URL("../../scripts/tsx.mjs", import.meta.url).href] },
    );
    try {
      const [result] = await once(worker, "message");
      expect(result).toEqual({
        self: true,
        parent: true,
        current: parentStart === null ? null : true,
      });
    } finally {
      await worker.terminate();
    }
  },
);
