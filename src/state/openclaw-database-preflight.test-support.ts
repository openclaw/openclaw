import { spawnSync } from "node:child_process";
import { expect } from "vitest";

/** Capture persistent artifacts without releasing the test writer's POSIX locks. */
export function snapshotPreflightSourceManifest(stateDir: string, allowAgentReadMarks?: string) {
  // Opening/closing the main file in the writer's process releases its POSIX
  // locks. Observe in a child so SQLite still sees a live owner during inspection.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import fs from "node:fs";
      import path from "node:path";
      import { createHash } from "node:crypto";
      const [stateDir, allowAgentReadMarks] = process.argv.slice(1);
      const manifest = fs.readdirSync(stateDir, { recursive: true, encoding: "utf8" })
        .filter(entry => !entry.startsWith("tmp" + path.sep))
        .filter(entry => fs.statSync(path.join(stateDir, entry)).isFile())
        .toSorted().map(entry => {
          const pathname = path.join(stateDir, entry);
          const bytes = fs.readFileSync(pathname);
          if (pathname === allowAgentReadMarks + "-shm") bytes.fill(0, 100, 120);
          return [entry, createHash("sha256").update(bytes).digest("hex")];
        });
      console.log(JSON.stringify(manifest));
      `,
      stateDir,
      allowAgentReadMarks ?? "",
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
