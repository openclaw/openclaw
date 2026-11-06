// Manifest transaction tests for the remote workspace sync scripts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { workspaceFile } from "./workspace-manifest-fixtures.test-support.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";
import {
  createScriptWorkspace,
  expectWorkspaceFiles as expectFiles,
  initializeScriptGitWorkspace,
  writeWorkspaceFiles as writeFiles,
  workspaceScriptRunner,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));

async function expectNoTransactions(root: string) {
  expect((await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-"))).toEqual(
    [],
  );
}

function transactionRunner(workspace: string, env = process.env) {
  // Unlike manifests, transactions take the action before the workspace.
  const runTransaction = (action: string, nonce: string, input?: string) =>
    runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS, action, workspace, nonce],
      { timeoutMs: 10_000, baseEnv: env, input },
    );
  const begin = (nonce: string, paths: string[]) =>
    runTransaction("begin", nonce, JSON.stringify(paths));
  return {
    runTransaction,
    begin,
    stage: async (nonce: string, files: Record<string, string>, paths = Object.keys(files)) => {
      const begun = await begin(nonce, paths);
      expect(begun.code).toBe(0);
      const staging = begun.stdout.trim();
      expect((await fs.stat(staging)).isDirectory()).toBe(true);
      await writeFiles(staging, files);
      return staging;
    },
    ok: async (action: string, nonce: string) => {
      expect((await runTransaction(action, nonce)).code).toBe(0);
    },
  };
}

async function fixture(prefix: string) {
  const workspace = await createScriptWorkspace(tempDirs.make(prefix));
  return {
    ...workspace,
    capture: async (...args: string[]) => {
      const result = await workspace.runManifest(args);
      expect(result.code, result.stderr).toBe(0);
      const ref = result.stdout.trim();
      const digest = ref.slice("sha256:".length);
      const file = path.join(workspace.manifestRoot, `${digest}.json`);
      const raw = await fs.readFile(file, "utf8");
      return { ref, digest, file, raw, manifest: parseWorkerWorkspaceManifest(raw, ref) };
    },
  };
}

async function transactionWorkspace(prefix: string) {
  const root = tempDirs.make(prefix);
  const target = path.join(root, "workspace");
  await fs.mkdir(target);
  const workspace = await fs.realpath(target);
  await fs.writeFile(path.join(workspace, "result.txt"), "old\n");
  return { root, workspace, ...transactionRunner(workspace) };
}

function spawnTransaction(argv: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
  const ready = createDeferred();
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.split("\n").includes("fixture ready")) {
      ready.resolve();
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // close follows stdout drainage, so a readiness line cannot lose to successful settlement.
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return {
    child,
    exited,
    waitUntilReady: (signal: AbortSignal, message: string) =>
      withinTest(awaitGateBeforeSettlement(ready.promise, exited, message), signal),
  };
}

describe("remote workspace manifest script", () => {
  it("preserves authenticated executable modes when Windows cannot represent them", async () => {
    const { home, workspace, env } = await fixture("openclaw-windows-manifest-modes-");
    const file = path.join(workspace, "script.sh");
    const original = Buffer.from("#!/bin/sh\necho before\n");
    await fs.writeFile(file, original, { mode: 0o644 });
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [{ ...workspaceFile("script.sh", original), mode: 0o755 }],
    });
    const digest = createHash("sha256").update(rawManifest).digest("hex");
    const windowsScript = `Object.defineProperty(process, "platform", { value: "win32" });\n${REMOTE_WORKSPACE_MANIFEST_JS}`;

    const runWindows = workspaceScriptRunner(windowsScript, workspace, env);

    const published = await runWindows(["", "publish", digest], { input: rawManifest });
    expect(published).toMatchObject({ code: 0, stdout: `sha256:${digest}\n` });

    const capture = () => runWindows(["", "all", digest]);
    expect(await capture()).toMatchObject({ code: 0, stdout: `sha256:${digest}\n` });

    await fs.writeFile(file, "#!/bin/sh\necho changed\n");
    await fs.writeFile(path.join(workspace, "new.txt"), "new\n", { mode: 0o644 });
    const changed = await capture();
    expect(changed.code, changed.stderr).toBe(0);
    const changedDigest = changed.stdout.trim().slice("sha256:".length);
    const changedRaw = await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${changedDigest}.json`),
      "utf8",
    );
    const manifest = parseWorkerWorkspaceManifest(changedRaw, changed.stdout.trim());
    expect(manifest.entries).toEqual([
      expect.objectContaining({ path: "new.txt", mode: 0o644 }),
      expect.objectContaining({ path: "script.sh", mode: 0o755 }),
    ]);
  });

  it("atomically applies and rolls back accepted workspace paths", async () => {
    const { workspace, env } = await fixture("openclaw-accepted-paths-test-");
    await fs.writeFile(path.join(workspace, "node"), "old file\n");

    const { runTransaction, begin, stage, ok } = transactionRunner(workspace, env);
    for (const unsafePath of [".", ".."]) {
      const rejected = await runTransaction("begin", "f".repeat(32), JSON.stringify([unsafePath]));
      expect(rejected.code).not.toBe(0);
      await fs.access(workspace);
    }

    const nonce = "a".repeat(32);
    const staging = await stage(
      nonce,
      {
        "node/child.txt": "new child\n",
        "added.txt": "added\n",
      },
      ["node/child.txt", "node", "added.txt"],
    );
    await ok("apply", nonce);
    await expectFiles(workspace, { "node/child.txt": "new child\n", "added.txt": "added\n" });

    await writeJson(path.join(path.dirname(staging), "phase.json"), {
      version: 1,
      nonce,
      phase: "applying",
    });
    const recoveryNonce = "b".repeat(32);
    const recoveryBegin = await begin(recoveryNonce, ["node"]);
    expect(recoveryBegin.code).toBe(0);
    await expectFiles(workspace, { node: "old file\n", "added.txt": null });
    await ok("rollback", recoveryNonce);

    const legacyNonce = "6".repeat(32);
    const legacyStaging = await stage(legacyNonce, { node: "legacy applied\n" });
    const legacyTransaction = path.dirname(legacyStaging);
    await ok("apply", legacyNonce);
    await fs.rm(path.join(legacyTransaction, "phase.json"));
    await fs.writeFile(path.join(legacyTransaction, "applied"), "");
    const legacyRecoveryNonce = "7".repeat(32);
    expect(await begin(legacyRecoveryNonce, ["node"])).toMatchObject({ code: 0 });
    await expectFiles(workspace, { node: "old file\n" });
    await ok("rollback", legacyRecoveryNonce);

    await fs.rm(path.join(workspace, "node"));
    await fs.mkdir(path.join(workspace, "node"));
    await fs.writeFile(path.join(workspace, "node/old.txt"), "read only\n");
    await fs.chmod(path.join(workspace, "node"), 0o555);

    const committedNonce = "c".repeat(32);
    const committedStaging = await stage(committedNonce, { "node/child.txt": "committed\n" }, [
      "node/child.txt",
      "node",
    ]);
    expect(await runTransaction("apply", committedNonce)).toMatchObject({ code: 0, stderr: "" });
    const committedTransaction = path.dirname(committedStaging);
    const interruptedCleanup = path.join(
      path.dirname(committedTransaction),
      path
        .basename(committedTransaction)
        .replace(".openclaw-accepted-", ".openclaw-accepted-cleanup-"),
    );
    await fs.rename(committedTransaction, interruptedCleanup);

    const cleanupNonce = "d".repeat(32);
    const cleanupBegin = await begin(cleanupNonce, ["node"]);
    expect(cleanupBegin.code).toBe(0);
    await ok("rollback", cleanupNonce);

    await expectFiles(workspace, { "node/child.txt": "committed\n" });
    await expect(fs.access(interruptedCleanup)).rejects.toThrow();

    await fs.chmod(path.join(workspace, "node"), 0o555);
    const modeRollbackNonce = "e".repeat(32);
    await stage(modeRollbackNonce, { "node/replacement.txt": "replacement\n" }, ["node"]);
    await ok("apply", modeRollbackNonce);
    await ok("rollback", modeRollbackNonce);
    expect((await fs.stat(path.join(workspace, "node"))).mode & 0o777).toBe(0o555);
    await expectFiles(workspace, { "node/child.txt": "committed\n" });
    await fs.chmod(path.join(workspace, "node"), 0o700);

    const interruptedModeNonce = "1".repeat(32);
    const interruptedModeBegin = await begin(interruptedModeNonce, ["node"]);
    const interruptedModeTransaction = path.dirname(interruptedModeBegin.stdout.trim());
    await fs.writeFile(
      path.join(interruptedModeTransaction, "state.json"),
      JSON.stringify([{ relative: "node", hadLive: true, directoryMode: 0o555 }]),
      { mode: 0o600 },
    );
    await ok("rollback", interruptedModeNonce);
    expect((await fs.stat(path.join(workspace, "node"))).mode & 0o777).toBe(0o555);
    await fs.chmod(path.join(workspace, "node"), 0o700);

    await fs.mkdir(path.join(workspace, "parent"));
    await fs.writeFile(path.join(workspace, "parent/child.txt"), "before\n");
    const ancestorModeNonce = "2".repeat(32);
    await stage(ancestorModeNonce, { "parent/child.txt": "after\n" });
    await fs.chmod(path.join(workspace, "parent"), 0o555);
    await fs.chmod(workspace, 0o555);
    expect(await runTransaction("apply", ancestorModeNonce)).toMatchObject({ code: 0, stderr: "" });
    await expectFiles(workspace, { "parent/child.txt": "after\n" });
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(workspace, "parent"))).mode & 0o777).toBe(0o555);
    await ok("rollback", ancestorModeNonce);
    await expectFiles(workspace, { "parent/child.txt": "before\n" });
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(workspace, "parent"))).mode & 0o777).toBe(0o555);
    await fs.chmod(workspace, 0o700);
    await fs.chmod(path.join(workspace, "parent"), 0o700);
  });

  // The in-flight applied outcome is covered by workspace-accepted-sync.test.ts.
  it.each(["begun", "committed"] as const)(
    "reports strict settlement for %s transactions",
    async (outcome) => {
      const { root, workspace, runTransaction, begin, stage, ok } = await transactionWorkspace(
        "openclaw-accepted-settlement-outcomes-",
      );
      const nonce = "a".repeat(32);
      if (outcome === "begun") {
        expect(await begin(nonce, ["result.txt"])).toMatchObject({ code: 0 });
      } else {
        await stage(nonce, { "result.txt": `${outcome}\n` });
        await ok("apply", nonce);
        await ok("commit", nonce);
      }
      expect(await runTransaction("settle", nonce)).toMatchObject({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({ version: 1, outcome })}\n`,
      });
      if (outcome === "committed") {
        await ok("recover", "d".repeat(32));
        await expectFiles(workspace, { "result.txt": "committed\n" });
      } else {
        await ok("rollback", nonce);
      }
      await expectNoTransactions(root);
    },
  );

  it("serializes a live apply against rollback and recovery", async ({ signal }) => {
    for (const contender of ["rollback", "recover"] as const) {
      const { root, workspace } = await transactionWorkspace(`openclaw-accepted-${contender}-`);
      const preload = path.join(root, "gate.cjs");
      await fs.writeFile(
        preload,
        `const fs = require("node:fs");
const path = require("node:path");
const renameSync = fs.renameSync;
let applyGated = false;
fs.renameSync = function(source, destination) {
  const result = renameSync.apply(this, arguments);
  if (!applyGated && process.argv[1] === "apply" && source === process.env.OPENCLAW_TEST_GATE_SOURCE && destination.includes(path.sep + "backup" + path.sep)) {
    applyGated = true;
    fs.writeSync(1, "fixture ready\\n");
    fs.readFileSync(0);
  }
  return result;
};
const kill = process.kill.bind(process);
let contenderMarked = false;
process.kill = function(pid, signal) {
  if (!contenderMarked && signal === 0 && process.argv[1] === process.env.OPENCLAW_TEST_CONTENDER) {
    contenderMarked = true;
    fs.writeSync(1, "fixture ready\\n");
  }
  return kill(pid, signal);
};
`,
      );
      const env = {
        ...process.env,
        OPENCLAW_TEST_GATE_SOURCE: path.join(workspace, "result.txt"),
        OPENCLAW_TEST_CONTENDER: contender,
      };
      const nonce = contender === "rollback" ? "3".repeat(32) : "4".repeat(32);
      const { begin: beginTransaction } = transactionRunner(workspace, env);
      const begin = await beginTransaction(nonce, ["result.txt"]);
      expect(begin.code).toBe(0);
      const staging = begin.stdout.trim();
      await fs.writeFile(path.join(staging, "result.txt"), "new\n");

      const spawnAction = (action: string, actionNonce: string) =>
        spawnTransaction(
          [
            "--require",
            preload,
            "-e",
            REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
            action,
            workspace,
            actionNonce,
          ],
          env,
        );
      const apply = spawnAction("apply", nonce);
      let competing: ReturnType<typeof spawnTransaction> | undefined;
      try {
        await apply.waitUntilReady(signal, "apply did not reach its gate");
        const transaction = path.dirname(staging);
        await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
        await expectFiles(transaction, { "backup/result.txt": "old\n" });
        await expectFiles(staging, { "result.txt": "new\n" });

        const contenderNonce = contender === "rollback" ? nonce : "5".repeat(32);
        competing = spawnAction(contender, contenderNonce);
        await competing.waitUntilReady(signal, "contender did not reach its gate");
        await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
        await expectFiles(transaction, { "backup/result.txt": "old\n" });

        apply.child.stdin.end("release");
        expect(await withinTest(apply.exited, signal)).toMatchObject({
          code: 0,
          signal: null,
          stderr: "",
        });
        expect(await withinTest(competing.exited, signal)).toMatchObject({ code: 0, stderr: "" });
        await expectFiles(workspace, { "result.txt": "old\n" });
        await expectNoTransactions(root);
      } finally {
        apply.child.kill("SIGKILL");
        competing?.child.kill("SIGKILL");
        await Promise.allSettled([apply.exited, competing?.exited]);
      }
    }
  });

  it("restores a dead reclaimer before settling its dead apply owner", async () => {
    const { root, workspace } = await transactionWorkspace("openclaw-accepted-dead-owner-");
    const nonce = "8".repeat(32);
    const { runTransaction: run } = transactionRunner(workspace);
    const runTransaction = (action: string, input?: string) => run(action, nonce, input);
    const begin = await runTransaction("begin", JSON.stringify(["result.txt"]));
    expect(begin.code).toBe(0);
    const transaction = path.dirname(begin.stdout.trim());
    await Promise.all([
      writeJson(path.join(transaction, "phase.json"), { version: 1, nonce, phase: "applying" }),
      writeJson(path.join(transaction, "state.json"), [{ relative: "result.txt", hadLive: true }]),
    ]);
    await fs.rename(
      path.join(workspace, "result.txt"),
      path.join(transaction, "backup/result.txt"),
    );
    const workspaceKey = createHash("sha256").update(workspace).digest("hex");
    const lock = path.join(root, `.openclaw-accepted-lock-${workspaceKey}`);
    const deadPid = 2_147_483_647;
    const token = "9".repeat(32);
    await fs.mkdir(lock);
    const invalidOwner = ["apply", nonce, deadPid, deadPid - 1, token].join(".");
    const invalidEntry = path.join(lock, `owner.${invalidOwner}`);
    await fs.writeFile(invalidEntry, "");
    const rejected = await runTransaction("settle");
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("invalid workspace mutation lock owner");
    await fs.unlink(invalidEntry);
    const ownerIdentity = ["apply", nonce, deadPid, deadPid, token].join(".");
    const reclaimToken = "a".repeat(32);
    const reclaimerIdentity = ["settle", nonce, deadPid, deadPid, reclaimToken].join(".");
    await fs.writeFile(path.join(lock, `reclaim.${ownerIdentity}.${reclaimerIdentity}`), "");

    const settled = await runTransaction("settle");

    expect(settled).toMatchObject({
      code: 0,
      stderr: "",
      stdout: `${JSON.stringify({ version: 1, outcome: "rolled-back" })}\n`,
    });
    await expectFiles(workspace, { "result.txt": "old\n" });
    await expectNoTransactions(root);
  });

  it("keeps the gateway's canonical manifest available across a second turn", async () => {
    const { manifestRoot, workspace, runManifest, capture } = await fixture(
      "openclaw-manifest-lifecycle-test-",
    );
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");

    const initial = await capture(baseCommit, "eligible");

    await fs.writeFile(path.join(workspace, "notes.md"), "cloud edit\n", { mode: 0o664 });
    await writeFiles(workspace, {
      "Zebra.md": "upper\n",
      "éclair.md": "unicode\n",
      "älg.md": "collation\n",
    });
    const first = await capture(baseCommit, "eligible", initial.digest);
    expect(first.raw).toBe(serializeWorkerWorkspaceManifest(first.manifest));
    await fs.rm(first.file);
    const published = await runManifest(["", "publish", first.digest], { input: first.raw });
    expect(published).toMatchObject({ code: 0, stdout: first.ref + "\n" });
    await expect(fs.readFile(first.file, "utf8")).resolves.toBe(first.raw);

    const legacy = JSON.parse(first.raw) as {
      entries: Array<{ path: string; type: string; mode: number }>;
    };
    for (const entry of legacy.entries) {
      if (entry.path === "notes.md") {
        entry.mode = 0o664;
      }
    }
    legacy.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const legacyRaw = JSON.stringify(legacy);
    const legacyDigest = createHash("sha256").update(legacyRaw).digest("hex");
    await fs.writeFile(path.join(manifestRoot, `${legacyDigest}.json`), legacyRaw);
    await fs.rm(first.file);

    const legacyCanonical = structuredClone(legacy);
    for (const entry of legacyCanonical.entries) {
      if (entry.type === "directory") {
        entry.mode = 0o700;
      } else if (entry.type === "symlink") {
        entry.mode = 0o777;
      } else {
        entry.mode = (entry.mode & 0o111) === 0 ? 0o644 : 0o755;
      }
    }
    legacyCanonical.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const acceptedRaw = JSON.stringify(legacyCanonical);
    const acceptedDigest = createHash("sha256").update(acceptedRaw).digest("hex");
    const acceptedRef = `sha256:${acceptedDigest}`;
    const acceptedPath = path.join(manifestRoot, `${acceptedDigest}.json`);

    const recovered = await runManifest(["", "resolve", acceptedDigest]);
    expect(recovered).toMatchObject({ code: 0, stdout: acceptedRef + "\n" });
    await expect(fs.readFile(acceptedPath, "utf8")).resolves.toBe(acceptedRaw);

    await fs.writeFile(path.join(workspace, "notes.md"), "second cloud edit\n");
    expect((await capture(baseCommit, "eligible", acceptedDigest)).ref).not.toBe(acceptedRef);
  });

  it("keeps base tombstones in the final ignored-path verification", async () => {
    const { workspace, capture } = await fixture("openclaw-manifest-tombstone-test-");
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");

    await fs.writeFile(path.join(workspace, "artifact.txt"), "base artifact\n");
    const base = await capture(baseCommit, "eligible");

    await Promise.all([
      fs.writeFile(path.join(workspace, ".gitignore"), "artifact.txt\n"),
      fs.rm(path.join(workspace, "artifact.txt")),
    ]);
    const current = await capture(baseCommit, "eligible", base.digest);

    await fs.writeFile(path.join(workspace, "artifact.txt"), "late recreated artifact\n");
    expect((await capture(baseCommit, "eligible", current.digest, base.digest)).ref).not.toBe(
      current.ref,
    );
  });

  it("drops stale descendants when a tracked directory becomes a file", async () => {
    const { workspace, capture } = await fixture("openclaw-manifest-test-");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "old.txt"), "old");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
    const initial = await capture(baseCommit, "eligible", "");

    await fs.rm(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src"), "replacement");
    const { manifest } = await capture(baseCommit, "eligible", initial.digest);
    expect(manifest.entries).toContainEqual(expect.objectContaining({ path: "src", type: "file" }));
    expect(manifest.entries.some((entry) => entry.path === "src/old.txt")).toBe(false);
  });
});
