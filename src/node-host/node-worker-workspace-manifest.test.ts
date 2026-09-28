import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseRemoteWorkspaceManifestEnvelope } from "../gateway/worker-environments/workspace-hash-memo.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import * as gitExec from "../infra/git-exec.js";
import * as exec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../worker/node-workspace-protocol.js";
import {
  captureManifest,
  nodeWorkspaceManifestCapture,
  runNodeWorkspaceManifestCapture,
} from "./node-worker-workspace-commands.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const home = tempDirs.make("node-manifest-capture-");
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(home, "node"),
    env: { ...process.env, HOME: home },
  });
  const identity = {
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    generation: 1,
  };
  const { workspaceDir } = await runtime.exec({
    ...identity,
    argv: [NODE_WORKSPACE_DRAIN_COMMAND],
  });
  await fs.mkdir(workspaceDir, { recursive: true });
  const argv = ["node", "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspaceDir, "", "all", "memo-v1"];
  return { home, runtime, identity, workspaceDir, argv };
}

describe("resident node manifest capture", () => {
  it("captures, memoizes, and detects small edits through workspace exec without spawning", async () => {
    const { runtime, identity, workspaceDir, argv } = await fixture();
    const spawn = vi
      .spyOn(exec, "runCommandWithTimeout")
      .mockRejectedValue(new Error("unexpected child"));
    const file = path.join(workspaceDir, "file.txt");
    await fs.writeFile(file, "before");
    const capture = async (memo = "[]") => {
      const result = await runtime.exec({ ...identity, argv, input: memo });
      expect(result).toMatchObject({ code: 0, termination: "exit", workspaceDir });
      return parseRemoteWorkspaceManifestEnvelope(result.stdout);
    };
    const first = await capture();
    expect(first.metrics.contentHashCount).toBe(1);
    const second = await capture(JSON.stringify(first.memo));
    expect(second.manifestRef).toBe(first.manifestRef);
    expect(second.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
    await fs.writeFile(file, "after - different size");
    const changed = await capture(JSON.stringify(second.memo));
    expect(changed.manifestRef).not.toBe(first.manifestRef);
    expect(changed.metrics.contentHashCount).toBe(1);
    await fs.rm(file);
    expect((await capture(JSON.stringify(changed.memo))).manifestRef).not.toBe(changed.manifestRef);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the same canonical bytes for transfer capture and the standalone transport", async () => {
    const { home, workspaceDir } = await fixture();
    await fs.writeFile(path.join(workspaceDir, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.mkdir(path.join(workspaceDir, "empty"));
    if (process.platform !== "win32") {
      await fs.symlink("script.sh", path.join(workspaceDir, "alias"));
    }
    const emptyRef = `sha256:${createHash("sha256")
      .update(JSON.stringify({ version: 1, baseCommit: null, entries: [] }))
      .digest("hex")}`;
    const memo = new Map<string, string>();
    const native = await captureManifest({
      workspaceDir,
      manifestHome: home,
      baseCommit: null,
      referenceManifestRef: emptyRef,
      hashMemo: memo,
    });
    const child = await exec.runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspaceDir, "", "all"],
      { baseEnv: { ...process.env, HOME: home }, timeoutMs: 10_000 },
    );
    expect(child).toMatchObject({ code: 0, stdout: `${native}\n` });
    expect(memo.size).toBe(1);
  });

  it("rejects escaping symlinks and cancellation before capture", async () => {
    const { runtime, identity, workspaceDir, argv } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.exec({ ...identity, argv, input: "[]" }, controller.signal),
    ).rejects.toThrow();
    if (process.platform !== "win32") {
      await fs.symlink("../outside", path.join(workspaceDir, "escape"));
      await expect(runtime.exec({ ...identity, argv, input: "[]" })).rejects.toThrow("escapes");
    }
  });

  it("keeps Git eligibility and prior ignored paths identical without a manifest child", async () => {
    const { runtime, identity, workspaceDir } = await fixture();
    const homeDir = path.dirname(workspaceDir);
    const baseCommit = "a".repeat(40);
    await fs.writeFile(path.join(workspaceDir, ".gitignore"), "*.ignored\n");
    await fs.writeFile(path.join(workspaceDir, "keep.ignored"), "retained");
    await fs.writeFile(path.join(workspaceDir, "skip.ignored"), "excluded");
    await fs.writeFile(path.join(workspaceDir, "new.txt"), "new");
    expect(
      (await exec.runCommandWithTimeout(["git", "init", "-q", workspaceDir], { timeoutMs: 10_000 }))
        .code,
    ).toBe(0);
    const raw = JSON.stringify({
      version: 1,
      baseCommit,
      entries: [
        {
          path: "keep.ignored",
          type: "file",
          mode: 0o644,
          size: 8,
          sha256: createHash("sha256").update("retained").digest("hex"),
        },
      ],
    });
    const digest = createHash("sha256").update(raw).digest("hex");
    const manifestDir = path.join(homeDir, ".openclaw-worker", "manifests");
    await fs.mkdir(manifestDir, { recursive: true });
    await fs.writeFile(path.join(manifestDir, `${digest}.json`), raw);
    const argv = [
      "node",
      "-e",
      REMOTE_WORKSPACE_MANIFEST_JS,
      workspaceDir,
      baseCommit,
      "eligible",
      digest,
    ];
    const child = await exec.runCommandWithTimeout([process.execPath, ...argv.slice(1)], {
      baseEnv: { ...process.env, HOME: homeDir },
      timeoutMs: 10_000,
    });
    expect(child.code, child.stderr).toBe(0);
    const spawn = vi
      .spyOn(exec, "runCommandWithTimeout")
      .mockRejectedValue(new Error("unexpected manifest child"));
    const native = await runtime.exec({ ...identity, argv });
    expect(native.stdout).toBe(child.stdout);
    expect(spawn).not.toHaveBeenCalled();
    const captured = parseWorkerWorkspaceManifest(
      await fs.readFile(path.join(manifestDir, `${native.stdout.trim().slice(7)}.json`), "utf8"),
      native.stdout.trim(),
    );
    expect(captured.entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "keep.ignored",
      "new.txt",
    ]);
  });

  it("retains child execution for changed programs and different workspace paths", () => {
    const argv = ["node", "-e", REMOTE_WORKSPACE_MANIFEST_JS, "/workspace", "", "all", "memo-v1"];
    expect(nodeWorkspaceManifestCapture(argv, "/workspace")).toBeDefined();
    expect(nodeWorkspaceManifestCapture(argv, "/other")).toBeUndefined();
    expect(
      nodeWorkspaceManifestCapture(argv.with(2, `${REMOTE_WORKSPACE_MANIFEST_JS}\n`), "/workspace"),
    ).toBeUndefined();
    expect(
      nodeWorkspaceManifestCapture(argv.with(4, "a".repeat(40)).with(5, "eligible"), "/workspace"),
    ).toBeDefined();
  });

  it("keeps the workspace environment and joins a cancelled Git read before releasing capture", async () => {
    const { home, workspaceDir } = await fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    vi.spyOn(gitExec, "executeGitCommandBuffered").mockImplementation(
      async (cwd, args, options) => {
        expect(cwd).toBe(workspaceDir);
        expect(args[0]).toBe("ls-files");
        expect(options?.baseEnv).toMatchObject({
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        });
        expect(options?.signal).toBeDefined();
        expect(options?.killProcessTree).toBe(true);
        entered.resolve();
        await release.promise;
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      },
    );
    let settled = false;
    const capture = runNodeWorkspaceManifestCapture({
      argv: [workspaceDir, "a".repeat(40), "eligible"],
      home,
      maxHashMemoBytes: 60 * 1024,
      signal: controller.signal,
    }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await Promise.race([
        entered.promise,
        capture.then(() => {
          throw new Error("capture ended before Git admission");
        }),
      ]);
      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      expect(await capture).toBeInstanceOf(Error);
      expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
    } finally {
      controller.abort();
      release.resolve();
      await capture;
    }
  });
});
