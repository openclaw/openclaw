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
  initializeScriptGitWorkspace,
  workspaceScriptRunner,
} from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function transactionRunner(workspace: string, env = process.env) {
  // Unlike manifests, transactions take the action before the workspace.
  const runTransaction = (action: string, nonce: string, input?: string) =>
    runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS, action, workspace, nonce],
      { timeoutMs: 10_000, baseEnv: env, input },
    );
  return {
    runTransaction,
    begin: (nonce: string, paths: string[]) =>
      runTransaction("begin", nonce, JSON.stringify(paths)),
  };
}

const fixture = (prefix: string) => createScriptWorkspace(tempDirs.make(prefix));

async function expectFile(root: string, relative: string, content: string) {
  await expect(fs.readFile(path.join(root, relative), "utf8")).resolves.toBe(content);
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
  return { child, ready: ready.promise, exited };
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
      entries: [
        {
          path: "script.sh",
          type: "file",
          mode: 0o755,
          size: original.byteLength,
          sha256: createHash("sha256").update(original).digest("hex"),
        },
      ],
    });
    const digest = createHash("sha256").update(rawManifest).digest("hex");
    const windowsScript = `Object.defineProperty(process, "platform", { value: "win32" });\n${REMOTE_WORKSPACE_MANIFEST_JS}`;

    const runWindows = workspaceScriptRunner(windowsScript, workspace, env);

    const published = await runWindows(["", "publish", digest], { input: rawManifest });
    expect(published).toMatchObject({ code: 0, stdout: `sha256:${digest}\n` });

    const capture = async () => await runWindows(["", "all", digest]);
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

    const { runTransaction, begin } = transactionRunner(workspace, env);
    for (const unsafePath of [".", ".."]) {
      const rejected = await runTransaction("begin", "f".repeat(32), JSON.stringify([unsafePath]));
      expect(rejected.code).not.toBe(0);
      await fs.access(workspace);
    }

    const nonce = "a".repeat(32);
    const begun = await begin(nonce, ["node/child.txt", "node", "added.txt"]);
    expect(begun.code).toBe(0);
    const staging = begun.stdout.trim();
    await fs.mkdir(path.join(staging, "node"));
    await Promise.all([
      fs.writeFile(path.join(staging, "node/child.txt"), "new child\n"),
      fs.writeFile(path.join(staging, "added.txt"), "added\n"),
    ]);
    expect((await runTransaction("apply", nonce)).code).toBe(0);
    await expectFile(workspace, "node/child.txt", "new child\n");
    await expectFile(workspace, "added.txt", "added\n");

    await fs.writeFile(
      path.join(path.dirname(staging), "phase.json"),
      JSON.stringify({ version: 1, nonce, phase: "applying" }),
    );
    const recoveryNonce = "b".repeat(32);
    const recoveryBegin = await begin(recoveryNonce, ["node"]);
    expect(recoveryBegin.code).toBe(0);
    await expectFile(workspace, "node", "old file\n");
    await expect(fs.access(path.join(workspace, "added.txt"))).rejects.toThrow();
    expect((await runTransaction("rollback", recoveryNonce)).code).toBe(0);

    const legacyNonce = "6".repeat(32);
    const legacyBegin = await begin(legacyNonce, ["node"]);
    const legacyTransaction = path.dirname(legacyBegin.stdout.trim());
    await fs.writeFile(path.join(legacyBegin.stdout.trim(), "node"), "legacy applied\n");
    expect((await runTransaction("apply", legacyNonce)).code).toBe(0);
    await fs.rm(path.join(legacyTransaction, "phase.json"));
    await fs.writeFile(path.join(legacyTransaction, "applied"), "");
    const legacyRecoveryNonce = "7".repeat(32);
    expect(await begin(legacyRecoveryNonce, ["node"])).toMatchObject({ code: 0 });
    await expectFile(workspace, "node", "old file\n");
    expect((await runTransaction("rollback", legacyRecoveryNonce)).code).toBe(0);

    await fs.rm(path.join(workspace, "node"));
    await fs.mkdir(path.join(workspace, "node"));
    await fs.writeFile(path.join(workspace, "node/old.txt"), "read only\n");
    await fs.chmod(path.join(workspace, "node"), 0o555);

    const committedNonce = "c".repeat(32);
    const committedBegin = await begin(committedNonce, ["node/child.txt", "node"]);
    const committedStaging = committedBegin.stdout.trim();
    await fs.mkdir(path.join(committedStaging, "node"));
    await fs.writeFile(path.join(committedStaging, "node/child.txt"), "committed\n");
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
    expect((await runTransaction("rollback", cleanupNonce)).code).toBe(0);

    await expectFile(workspace, "node/child.txt", "committed\n");
    await expect(fs.access(interruptedCleanup)).rejects.toThrow();

    await fs.chmod(path.join(workspace, "node"), 0o555);
    const modeRollbackNonce = "e".repeat(32);
    const modeRollbackBegin = await begin(modeRollbackNonce, ["node"]);
    const modeRollbackStaging = modeRollbackBegin.stdout.trim();
    await fs.mkdir(path.join(modeRollbackStaging, "node"));
    await fs.writeFile(path.join(modeRollbackStaging, "node/replacement.txt"), "replacement\n");
    expect((await runTransaction("apply", modeRollbackNonce)).code).toBe(0);
    expect((await runTransaction("rollback", modeRollbackNonce)).code).toBe(0);
    expect((await fs.stat(path.join(workspace, "node"))).mode & 0o777).toBe(0o555);
    await expectFile(workspace, "node/child.txt", "committed\n");
    await fs.chmod(path.join(workspace, "node"), 0o700);

    const interruptedModeNonce = "1".repeat(32);
    const interruptedModeBegin = await begin(interruptedModeNonce, ["node"]);
    const interruptedModeTransaction = path.dirname(interruptedModeBegin.stdout.trim());
    await fs.writeFile(
      path.join(interruptedModeTransaction, "state.json"),
      JSON.stringify([{ relative: "node", hadLive: true, directoryMode: 0o555 }]),
      { mode: 0o600 },
    );
    expect((await runTransaction("rollback", interruptedModeNonce)).code).toBe(0);
    expect((await fs.stat(path.join(workspace, "node"))).mode & 0o777).toBe(0o555);
    await fs.chmod(path.join(workspace, "node"), 0o700);

    await fs.mkdir(path.join(workspace, "parent"));
    await fs.writeFile(path.join(workspace, "parent/child.txt"), "before\n");
    const ancestorModeNonce = "2".repeat(32);
    const ancestorModeBegin = await begin(ancestorModeNonce, ["parent/child.txt"]);
    const ancestorModeStaging = ancestorModeBegin.stdout.trim();
    await fs.mkdir(path.join(ancestorModeStaging, "parent"));
    await fs.writeFile(path.join(ancestorModeStaging, "parent/child.txt"), "after\n");
    await fs.chmod(path.join(workspace, "parent"), 0o555);
    await fs.chmod(workspace, 0o555);
    expect(await runTransaction("apply", ancestorModeNonce)).toMatchObject({ code: 0, stderr: "" });
    await expectFile(workspace, "parent/child.txt", "after\n");
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(workspace, "parent"))).mode & 0o777).toBe(0o555);
    expect((await runTransaction("rollback", ancestorModeNonce)).code).toBe(0);
    await expectFile(workspace, "parent/child.txt", "before\n");
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(workspace, "parent"))).mode & 0o777).toBe(0o555);
    await fs.chmod(workspace, 0o700);
    await fs.chmod(path.join(workspace, "parent"), 0o700);
  });

  it("reports strict settlement outcomes for each durable transaction phase", async () => {
    const { root, workspace, runTransaction, begin } = await transactionWorkspace(
      "openclaw-accepted-settlement-outcomes-",
    );
    const expectSettlement = (
      value: Awaited<ReturnType<typeof runTransaction>>,
      outcome: "begun" | "rolled-back" | "applied" | "committed",
    ) => {
      expect(value).toMatchObject({
        code: 0,
        stderr: "",
        stdout: `${JSON.stringify({ version: 1, outcome })}\n`,
      });
    };

    const begunNonce = "a".repeat(32);
    expect(await begin(begunNonce, ["result.txt"])).toMatchObject({ code: 0 });
    expectSettlement(await runTransaction("settle", begunNonce), "begun");
    expect(await runTransaction("rollback", begunNonce)).toMatchObject({ code: 0 });

    const appliedNonce = "b".repeat(32);
    const appliedBegin = await begin(appliedNonce, ["result.txt"]);
    await fs.writeFile(path.join(appliedBegin.stdout.trim(), "result.txt"), "applied\n");
    expect(await runTransaction("apply", appliedNonce)).toMatchObject({ code: 0 });
    expectSettlement(await runTransaction("settle", appliedNonce), "applied");
    expect(await runTransaction("rollback", appliedNonce)).toMatchObject({ code: 0 });

    const committedNonce = "c".repeat(32);
    const committedBegin = await begin(committedNonce, ["result.txt"]);
    await fs.writeFile(path.join(committedBegin.stdout.trim(), "result.txt"), "committed\n");
    expect(await runTransaction("apply", committedNonce)).toMatchObject({ code: 0 });
    expect(await runTransaction("commit", committedNonce)).toMatchObject({ code: 0 });
    expectSettlement(await runTransaction("settle", committedNonce), "committed");
    expect(await runTransaction("recover", "d".repeat(32))).toMatchObject({ code: 0 });
    await expectFile(workspace, "result.txt", "committed\n");
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-")),
    ).toEqual([]);
  });

  it("serializes a live apply against rollback and recovery", async ({ signal }) => {
    for (const contender of ["rollback", "recover"] as const) {
      const root = tempDirs.make(`openclaw-accepted-${contender}-`);
      let workspace = path.join(root, "workspace");
      const applyMarker = path.join(root, "apply-started");
      const contenderMarker = path.join(root, "contender-waiting");
      const preload = path.join(root, "gate.cjs");
      await fs.mkdir(workspace);
      workspace = await fs.realpath(workspace);
      await fs.writeFile(path.join(workspace, "result.txt"), "old\n");
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
        await withinTest(
          awaitGateBeforeSettlement(
            apply.ready,
            apply.exited,
            `timeout waiting for ${applyMarker}`,
          ),
          signal,
        );
        const transaction = path.dirname(staging);
        await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
        await expectFile(transaction, "backup/result.txt", "old\n");
        await expectFile(staging, "result.txt", "new\n");

        const contenderNonce = contender === "rollback" ? nonce : "5".repeat(32);
        competing = spawnAction(contender, contenderNonce);
        await withinTest(
          awaitGateBeforeSettlement(
            competing.ready,
            competing.exited,
            `timeout waiting for ${contenderMarker}`,
          ),
          signal,
        );
        await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toThrow();
        await expectFile(transaction, "backup/result.txt", "old\n");

        apply.child.stdin.end("release");
        expect(await withinTest(apply.exited, signal)).toMatchObject({
          code: 0,
          signal: null,
          stderr: "",
        });
        expect(await withinTest(competing.exited, signal)).toMatchObject({ code: 0, stderr: "" });
        await expectFile(workspace, "result.txt", "old\n");
        expect(
          (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-")),
        ).toEqual([]);
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
      fs.writeFile(
        path.join(transaction, "phase.json"),
        JSON.stringify({ version: 1, nonce, phase: "applying" }),
      ),
      fs.writeFile(
        path.join(transaction, "state.json"),
        JSON.stringify([{ relative: "result.txt", hadLive: true }]),
      ),
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
    await expectFile(workspace, "result.txt", "old\n");
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith(".openclaw-accepted-")),
    ).toEqual([]);
  });

  it("keeps the gateway's canonical manifest available across a second turn", async () => {
    const { home, workspace, runManifest } = await fixture("openclaw-manifest-lifecycle-test-");
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");

    const initial = await runManifest([baseCommit, "eligible"]);
    expect(initial.code).toBe(0);

    await fs.writeFile(path.join(workspace, "notes.md"), "cloud edit\n", { mode: 0o664 });
    await Promise.all([
      fs.writeFile(path.join(workspace, "Zebra.md"), "upper\n"),
      fs.writeFile(path.join(workspace, "éclair.md"), "unicode\n"),
      fs.writeFile(path.join(workspace, "älg.md"), "collation\n"),
    ]);
    const firstTurn = await runManifest([
      baseCommit,
      "eligible",
      initial.stdout.trim().slice("sha256:".length),
    ]);
    expect(firstTurn.code).toBe(0);
    const firstTurnRef = firstTurn.stdout.trim();
    const firstTurnDigest = firstTurnRef.slice("sha256:".length);
    const manifestRoot = path.join(home, ".openclaw-worker", "manifests");
    const firstTurnPath = path.join(manifestRoot, `${firstTurnDigest}.json`);
    const firstTurnRaw = await fs.readFile(firstTurnPath, "utf8");
    const firstTurnManifest = parseWorkerWorkspaceManifest(firstTurnRaw, firstTurnRef);
    expect(firstTurnRaw).toBe(serializeWorkerWorkspaceManifest(firstTurnManifest));
    const firstTurnPaths = (
      JSON.parse(firstTurnRaw) as { entries: Array<{ path: string }> }
    ).entries.map((entry) => entry.path);
    expect(firstTurnPaths).toEqual(
      firstTurnPaths.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );

    await fs.rm(firstTurnPath);
    const published = await runManifest(["", "publish", firstTurnDigest], { input: firstTurnRaw });
    expect(published).toMatchObject({ code: 0, stdout: firstTurnRef + "\n" });
    await expect(fs.readFile(firstTurnPath, "utf8")).resolves.toBe(firstTurnRaw);

    const legacy = JSON.parse(firstTurnRaw) as {
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
    await fs.rm(firstTurnPath);

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
    const secondTurn = await runManifest([baseCommit, "eligible", acceptedDigest]);
    expect(secondTurn.code).toBe(0);
    expect(secondTurn.stdout.trim()).not.toBe(acceptedRef);
  });

  it("keeps base tombstones in the final ignored-path verification", async () => {
    const { workspace, runManifest } = await fixture("openclaw-manifest-tombstone-test-");
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".gitignore");

    await fs.writeFile(path.join(workspace, "artifact.txt"), "base artifact\n");
    const base = await runManifest([baseCommit, "eligible"]);
    expect(base.code).toBe(0);
    const baseDigest = base.stdout.trim().slice("sha256:".length);

    await Promise.all([
      fs.writeFile(path.join(workspace, ".gitignore"), "artifact.txt\n"),
      fs.rm(path.join(workspace, "artifact.txt")),
    ]);
    const current = await runManifest([baseCommit, "eligible", baseDigest]);
    expect(current.code).toBe(0);
    const currentRef = current.stdout.trim();
    const currentDigest = currentRef.slice("sha256:".length);

    await fs.writeFile(path.join(workspace, "artifact.txt"), "late recreated artifact\n");
    const verified = await runManifest([baseCommit, "eligible", currentDigest, baseDigest]);
    expect(verified.code).toBe(0);
    expect(verified.stdout.trim()).not.toBe(currentRef);
  });

  it("drops stale descendants when a tracked directory becomes a file", async () => {
    const { workspace, runManifest, readManifest } = await fixture("openclaw-manifest-test-");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "old.txt"), "old");
    const baseCommit = await initializeScriptGitWorkspace(workspace, ".");
    const initial = await runManifest([baseCommit, "eligible", ""]);
    expect(initial.code).toBe(0);

    await fs.rm(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src"), "replacement");
    const current = await runManifest([
      baseCommit,
      "eligible",
      initial.stdout.trim().slice("sha256:".length),
    ]);
    expect(current.code).toBe(0);
    const manifest = await readManifest(current.stdout.trim());
    expect(manifest.entries).toContainEqual(expect.objectContaining({ path: "src", type: "file" }));
    expect(manifest.entries.some((entry) => entry.path === "src/old.txt")).toBe(false);
  });
});
