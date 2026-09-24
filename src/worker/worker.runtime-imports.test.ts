import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { workerImportRuntimeEntrypoints } from "./worker-import-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeUrl = resolveRuntimeWorkerUrl(workerImportRuntimeEntrypoints.runtime);

describe("worker runtime imports during admission", () => {
  it.each([
    ["rejected", "preserves rejected hello and joins both imports after one rejects"],
    ["cancelled", "preserves cancellation and joins both imports after one rejects"],
    ["import-error", "surfaces import failure after accepted hello and joins the pending import"],
    ["accepted", "waits for accepted hello before constructing the stream or running the turn"],
  ])("%s: %s", async (mode) => {
    const root = tempDirs.make("worker-runtime-imports-");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const result = await runNodeScript(
      [
        "--unhandled-rejections=strict",
        ...resolveRuntimeWorkerArgv(runtimeUrl, resolveTestNodeExecPath()).slice(0, -1),
        fileURLToPath(new URL("./worker.runtime-imports.test-support.mjs", import.meta.url)),
        mode,
        workspace,
        runtimeUrl.href,
        resolveRuntimeWorkerUrl(workerImportRuntimeEntrypoints.launchDescriptor).href,
        resolveRuntimeWorkerUrl(workerImportRuntimeEntrypoints.admission).href,
        resolveRuntimeWorkerUrl(workerImportRuntimeEntrypoints.websocketData).href,
      ],
      {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        OPENCLAW_STATE_DIR: path.join(root, "ambient-state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "ambient-config.json"),
      },
      20_000,
      { cwd: repoRoot, maxBuffer: 1024 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, passed: true });
  });
});
