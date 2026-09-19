import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRuntime from "../../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { MAX_RECONCILIATION_TOTAL_BYTES } from "./workspace-manifest.js";
import { createWorkspacePatch } from "./workspace-reconcile-recovery.js";

vi.mock("./workspace-manifest.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-manifest.js")>()),
  MAX_RECONCILIATION_TOTAL_BYTES: 64 * 1024,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
});

it("stops an oversized patch before its destination exceeds the byte budget", async () => {
  const root = tempDirs.make("workspace-patch-limit-base-");
  const stagingRoot = tempDirs.make("workspace-patch-limit-current-");
  await fs.writeFile(path.join(root, "file.txt"), "old\n");
  await fs.writeFile(path.join(stagingRoot, "file.txt"), "new\n");
  const entry = (content: string) => ({
    path: "file.txt",
    type: "file" as const,
    mode: 0o644,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const opened: FileHandle[] = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      opened.push(handle);
    }
    return handle;
  });
  let maximumFileBytes = 0;
  const run = commandRuntime.runCommandWithTimeout;
  vi.spyOn(commandRuntime, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    if (!argv.includes("diff")) {
      return await run(argv, options);
    }
    const observer = typeof options === "object" ? options.onOutputChunk : undefined;
    const destination = argv.find((argument) => argument.startsWith("--output="))?.slice(9);
    const chunk = Buffer.alloc(MAX_RECONCILIATION_TOTAL_BYTES / 4, 0x61);
    // Exercise both Git output modes: a post-generation stat cannot enforce this bound.
    for (let index = 0; index < 5; index += 1) {
      if (destination) {
        await fs.appendFile(destination, chunk);
        maximumFileBytes = Math.max(maximumFileBytes, (await fs.stat(destination)).size);
      } else {
        const keepWriting = observer?.(chunk, "stdout");
        for (const handle of opened.filter((candidate) => candidate.fd >= 0)) {
          maximumFileBytes = Math.max(maximumFileBytes, fsSync.fstatSync(handle.fd).size);
        }
        if (keepWriting === false) {
          break;
        }
      }
    }
    return { stdout: "", stderr: "", code: 0, signal: null, killed: false, termination: "exit" };
  });

  await expect(
    createWorkspacePatch({
      root,
      stagingRoot,
      baseEntries: [entry("old\n")],
      appliedEntries: [entry("new\n")],
    }),
  ).rejects.toThrow("patch exceeds its byte limit");
  expect(maximumFileBytes).toBe(MAX_RECONCILIATION_TOTAL_BYTES);
  expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe("old\n");
});
