import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { pluginRetentionEntrypoints } from "./retention-runtime.test-support.js";

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
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(pluginRetentionEntrypoints.cache)),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
