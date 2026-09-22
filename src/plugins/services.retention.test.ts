import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each([
  { name: "completed service generations", scenario: "generations" },
  { name: "completed handle publication", scenario: "on-handle" },
])(
  "releases $name while the newest service handle remains usable",
  async ({ scenario }) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./services.retention.test-support.ts", import.meta.url)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
