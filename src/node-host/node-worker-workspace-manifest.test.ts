import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { commandResult } from "../agents/github-identity.test-support.js";
import { parseRemoteWorkspaceManifestEnvelope } from "../gateway/worker-environments/workspace-hash-memo.js";
import { useAgedWorkspaceHashClock } from "../gateway/worker-environments/workspace-hash-memo.test-support.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import * as gitExec from "../infra/git-exec.js";
import * as exec from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";
import {
  fileEntry,
  manifestFixture,
  writeManifest,
} from "./node-worker-transfer-client.fixture.test-support.js";
import {
  captureManifest,
  nodeWorkspaceManifestCapture,
  readWorkspaceManifest,
  runNodeWorkspaceManifestCapture,
} from "./node-worker-workspace-commands.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
useAgedWorkspaceHashClock();
const command = ["node", "-e", REMOTE_WORKSPACE_MANIFEST_JS];
afterEach(() => vi.restoreAllMocks());

const rejectChild = () =>
  vi.spyOn(exec, "runCommandWithTimeout").mockRejectedValue(new Error("unexpected child"));

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
  const argv = (args = ["", "all", "memo-v1"]) => [...command, workspaceDir, ...args];
  const capture = (args?: string[], signal?: AbortSignal, input = args ? undefined : "[]") =>
    runtime.exec(
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...identity, argv: argv(args), input })),
      signal,
    );
  return {
    home,
    workspaceDir,
    capture,
    manifest: async (memo = "[]") => {
      const result = await capture(undefined, undefined, memo);
      expect(result).toMatchObject({ code: 0, termination: "exit", workspaceDir });
      return parseRemoteWorkspaceManifestEnvelope(result.stdout);
    },
    runStandalone: (args = ["", "all"], homeDir = home) =>
      exec.runCommandWithTimeout([process.execPath, ...argv(args).slice(1)], {
        baseEnv: { ...process.env, HOME: homeDir },
        timeoutMs: 10_000,
      }),
  };
}

describe("resident node manifest capture", () => {
  it("captures, memoizes, and detects small edits through parsed workspace exec without spawning", async () => {
    const { manifest: capture, workspaceDir } = await fixture();
    rejectChild();
    const file = path.join(workspaceDir, "file.txt");
    await fs.writeFile(file, "before");
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
  });

  it("uses the same canonical bytes for transfer capture and the standalone transport", async () => {
    const { home, workspaceDir, runStandalone } = await fixture();
    await fs.writeFile(path.join(workspaceDir, "script.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.mkdir(path.join(workspaceDir, "empty"));
    if (process.platform !== "win32") {
      await fs.symlink("script.sh", path.join(workspaceDir, "alias"));
    }
    const { manifestRef: emptyRef } = manifestFixture();
    const memo = new Map<string, string>();
    const native = await captureManifest({
      workspaceDir,
      manifestHome: home,
      baseCommit: null,
      referenceManifestRef: emptyRef,
      hashMemo: memo,
    });
    const child = await runStandalone();
    expect(child).toMatchObject({ code: 0, stdout: `${native}\n` });
    expect(memo.size).toBe(1);
    for (const maxHashMemoBytes of [2, 8192, 2]) {
      const captured = parseRemoteWorkspaceManifestEnvelope(
        await runNodeWorkspaceManifestCapture({
          argv: [workspaceDir, "", "all", "memo-v1"],
          home,
          memo: "[]",
          maxHashMemoBytes,
        }),
      );
      expect(captured.manifestRef).toBe(native);
      expect(captured.memo).toHaveLength(maxHashMemoBytes === 2 ? 0 : 1);
    }
  });

  it("rejects escaping symlinks and cancellation before capture", async () => {
    const { capture, workspaceDir } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(capture(undefined, controller.signal)).rejects.toThrow();
    if (process.platform !== "win32") {
      await fs.symlink("../outside", path.join(workspaceDir, "escape"));
      await expect(capture()).rejects.toThrow("escapes");
    }
  });

  it("keeps Git eligibility and prior ignored paths identical without a manifest child", async () => {
    const { capture, workspaceDir, runStandalone } = await fixture();
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
    const { rawManifest } = manifestFixture([fileEntry("keep.ignored", Buffer.from("retained"))], {
      baseCommit,
    });
    const digest = await writeManifest(homeDir, rawManifest);
    const args = [baseCommit, "eligible", digest];
    const child = await runStandalone(args, homeDir);
    expect(child.code, child.stderr).toBe(0);
    rejectChild();
    const native = await capture(args);
    expect(native.stdout).toBe(child.stdout);
    const { manifest } = await readWorkspaceManifest(homeDir, native.stdout.trim());
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "keep.ignored",
      "new.txt",
    ]);
  });

  it("retains child execution for changed programs and different workspace paths", () => {
    const argv = [...command, "/workspace", "", "all", "memo-v1"];
    expect(nodeWorkspaceManifestCapture(argv, "/other")).toBeUndefined();
    expect(
      nodeWorkspaceManifestCapture(argv.with(2, `${REMOTE_WORKSPACE_MANIFEST_JS}\n`), "/workspace"),
    ).toBeUndefined();
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
        expect(options).toMatchObject({
          baseEnv: { HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
          signal: expect.any(AbortSignal),
          killProcessTree: true,
        });
        entered.resolve();
        await release.promise;
        return commandResult();
      },
    );
    let settled = false;
    const capture = runNodeWorkspaceManifestCapture({
      argv: [workspaceDir, "a".repeat(40), "eligible"],
      home,
      maxHashMemoBytes: 60 * 1024,
      signal: controller.signal,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        capture,
        "capture ended before Git admission",
      );
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
