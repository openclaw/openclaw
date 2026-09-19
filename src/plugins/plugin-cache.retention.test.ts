import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each([
  "directory",
  "entry-boundary",
  "entry-hardlink",
  "file-missing",
  "file-hardlink",
  "file-read",
  "file-overflow",
  "regular-missing",
  "regular-overflow",
  "json",
  "json5",
  "formatter",
  "formatter-call-sites",
])(
  "preserves %s metadata failures across caller teardown",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./plugin-cache.retention.test-support.ts", import.meta.url)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
