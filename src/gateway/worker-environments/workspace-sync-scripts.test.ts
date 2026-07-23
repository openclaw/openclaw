import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("remote workspace manifest script", () => {
  it("atomically applies and rolls back accepted workspace paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-accepted-paths-test-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    await fs.writeFile(path.join(workspace, "node"), "old file\n");
    const env = { ...process.env, HOME: home };
    const runTransaction = async (action: string, nonce: string, input?: string) =>
      await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
          action,
          workspace,
          nonce,
        ],
        { timeoutMs: 10_000, baseEnv: env, input },
      );
    for (const unsafePath of [".", ".."]) {
      const rejected = await runTransaction("begin", "f".repeat(32), JSON.stringify([unsafePath]));
      expect(rejected.code).not.toBe(0);
      await expect(fs.access(workspace)).resolves.toBeUndefined();
    }

    const nonce = "a".repeat(32);
    const begun = await runTransaction(
      "begin",
      nonce,
      JSON.stringify(["node/child.txt", "node", "added.txt"]),
    );
    expect(begun.code).toBe(0);
    const staging = begun.stdout.trim();
    await fs.mkdir(path.join(staging, "node"));
    await Promise.all([
      fs.writeFile(path.join(staging, "node/child.txt"), "new child\n"),
      fs.writeFile(path.join(staging, "added.txt"), "added\n"),
    ]);
    expect((await runTransaction("apply", nonce)).code).toBe(0);
    await expect(fs.readFile(path.join(workspace, "node/child.txt"), "utf8")).resolves.toBe(
      "new child\n",
    );
    await expect(fs.readFile(path.join(workspace, "added.txt"), "utf8")).resolves.toBe("added\n");

    await fs.rm(path.join(path.dirname(staging), "applied"));
    const recoveryNonce = "b".repeat(32);
    const recoveryBegin = await runTransaction("begin", recoveryNonce, JSON.stringify(["node"]));
    expect(recoveryBegin.code).toBe(0);
    await expect(fs.readFile(path.join(workspace, "node"), "utf8")).resolves.toBe("old file\n");
    await expect(fs.access(path.join(workspace, "added.txt"))).rejects.toThrow();
    expect((await runTransaction("rollback", recoveryNonce)).code).toBe(0);
    await fs.rm(path.join(workspace, "node"));
    await fs.mkdir(path.join(workspace, "node"));
    await fs.writeFile(path.join(workspace, "node/old.txt"), "read only\n");
    await fs.chmod(path.join(workspace, "node"), 0o555);

    const committedNonce = "c".repeat(32);
    const committedBegin = await runTransaction(
      "begin",
      committedNonce,
      JSON.stringify(["node/child.txt", "node"]),
    );
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
    const cleanupBegin = await runTransaction("begin", cleanupNonce, JSON.stringify(["node"]));
    expect(cleanupBegin.code).toBe(0);
    expect((await runTransaction("rollback", cleanupNonce)).code).toBe(0);

    await expect(fs.readFile(path.join(workspace, "node/child.txt"), "utf8")).resolves.toBe(
      "committed\n",
    );
    await expect(fs.access(interruptedCleanup)).rejects.toThrow();

    await fs.chmod(path.join(workspace, "node"), 0o555);
    const modeRollbackNonce = "e".repeat(32);
    const modeRollbackBegin = await runTransaction(
      "begin",
      modeRollbackNonce,
      JSON.stringify(["node"]),
    );
    const modeRollbackStaging = modeRollbackBegin.stdout.trim();
    await fs.mkdir(path.join(modeRollbackStaging, "node"));
    await fs.writeFile(path.join(modeRollbackStaging, "node/replacement.txt"), "replacement\n");
    expect((await runTransaction("apply", modeRollbackNonce)).code).toBe(0);
    expect((await runTransaction("rollback", modeRollbackNonce)).code).toBe(0);
    expect((await fs.stat(path.join(workspace, "node"))).mode & 0o777).toBe(0o555);
    await expect(fs.readFile(path.join(workspace, "node/child.txt"), "utf8")).resolves.toBe(
      "committed\n",
    );
    await fs.chmod(path.join(workspace, "node"), 0o700);

    const interruptedModeNonce = "1".repeat(32);
    const interruptedModeBegin = await runTransaction(
      "begin",
      interruptedModeNonce,
      JSON.stringify(["node"]),
    );
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
    const ancestorModeBegin = await runTransaction(
      "begin",
      ancestorModeNonce,
      JSON.stringify(["parent/child.txt"]),
    );
    const ancestorModeStaging = ancestorModeBegin.stdout.trim();
    await fs.mkdir(path.join(ancestorModeStaging, "parent"));
    await fs.writeFile(path.join(ancestorModeStaging, "parent/child.txt"), "after\n");
    await fs.chmod(path.join(workspace, "parent"), 0o555);
    await fs.chmod(workspace, 0o555);
    expect(await runTransaction("apply", ancestorModeNonce)).toMatchObject({ code: 0, stderr: "" });
    await expect(fs.readFile(path.join(workspace, "parent/child.txt"), "utf8")).resolves.toBe(
      "after\n",
    );
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(workspace, "parent"))).mode & 0o777).toBe(0o555);
    expect((await runTransaction("rollback", ancestorModeNonce)).code).toBe(0);
    await expect(fs.readFile(path.join(workspace, "parent/child.txt"), "utf8")).resolves.toBe(
      "before\n",
    );
    expect((await fs.stat(workspace)).mode & 0o777).toBe(0o555);
    expect((await fs.stat(path.join(workspace, "parent"))).mode & 0o777).toBe(0o555);
    await fs.chmod(workspace, 0o700);
    await fs.chmod(path.join(workspace, "parent"), 0o700);
  });

  it("keeps the gateway's canonical manifest available across a second turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manifest-lifecycle-test-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    for (const args of [
      ["init", "--quiet"],
      ["add", ".gitignore"],
      [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ],
    ]) {
      const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(0);
    }
    const baseCommit = (
      await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const env = { ...process.env, HOME: home };
    const initial = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(initial.code).toBe(0);

    await fs.writeFile(path.join(workspace, "notes.md"), "cloud edit\n", { mode: 0o664 });
    await Promise.all([
      fs.writeFile(path.join(workspace, "Zebra.md"), "upper\n"),
      fs.writeFile(path.join(workspace, "éclair.md"), "unicode\n"),
      fs.writeFile(path.join(workspace, "älg.md"), "collation\n"),
    ]);
    const firstTurn = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        initial.stdout.trim().slice("sha256:".length),
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
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
    const published = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        "",
        "publish",
        firstTurnDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env, input: firstTurnRaw },
    );
    expect(published.code).toBe(0);
    expect(published.stdout.trim()).toBe(firstTurnRef);
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

    const recovered = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        "",
        "resolve",
        acceptedDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(recovered.code).toBe(0);
    expect(recovered.stdout.trim()).toBe(acceptedRef);
    await expect(fs.readFile(acceptedPath, "utf8")).resolves.toBe(acceptedRaw);

    await fs.writeFile(path.join(workspace, "notes.md"), "second cloud edit\n");
    const secondTurn = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        acceptedDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(secondTurn.code).toBe(0);
    expect(secondTurn.stdout.trim()).not.toBe(acceptedRef);
  });

  it("drops derived artifacts from the worker manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manifest-derived-test-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const files = [
      "keep.ts",
      "__pycache__/fizzbuzz.cpython-314.pyc",
      "generated.pyc",
      "generated.pyo",
      "cache.pyc/inside",
      "nested/.DS_Store/inside",
      ".pytest_cache/state",
      ".mypy_cache/state",
      ".ruff_cache/state",
      "node_modules/pkg/index.js",
      ".DS_Store",
    ];
    await Promise.all([fs.mkdir(home), fs.mkdir(workspace)]);
    await Promise.all(
      files.map(async (file) => {
        await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
        await fs.writeFile(path.join(workspace, file), file);
      }),
    );

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace],
      { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home } },
    );
    expect(result.code).toBe(0);
    const digest = result.stdout.trim().slice("sha256:".length);
    const manifest = JSON.parse(
      await fs.readFile(path.join(home, ".openclaw-worker", "manifests", `${digest}.json`), "utf8"),
    ) as { entries: Array<{ path: string }> };
    const manifestPaths = manifest.entries.map((entry) => entry.path);
    expect(manifestPaths).toContain("keep.ts");
    for (const excluded of files.slice(1)) {
      expect(manifestPaths).not.toContain(excluded);
    }
  });

  it("keeps base tombstones in the final ignored-path verification", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manifest-tombstone-test-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, ".gitignore"), "");
    for (const args of [
      ["init", "--quiet"],
      ["add", ".gitignore"],
      [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ],
    ]) {
      const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(0);
    }
    const baseCommit = (
      await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const env = { ...process.env, HOME: home };
    await fs.writeFile(path.join(workspace, "artifact.txt"), "base artifact\n");
    const base = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, workspace, baseCommit, "eligible"],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(base.code).toBe(0);
    const baseDigest = base.stdout.trim().slice("sha256:".length);

    await Promise.all([
      fs.writeFile(path.join(workspace, ".gitignore"), "artifact.txt\n"),
      fs.rm(path.join(workspace, "artifact.txt")),
    ]);
    const current = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        baseDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(current.code).toBe(0);
    const currentRef = current.stdout.trim();
    const currentDigest = currentRef.slice("sha256:".length);

    await fs.writeFile(path.join(workspace, "artifact.txt"), "late recreated artifact\n");
    const verified = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        baseCommit,
        "eligible",
        currentDigest,
        baseDigest,
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(verified.code).toBe(0);
    expect(verified.stdout.trim()).not.toBe(currentRef);
  });

  it("drops stale descendants when a tracked directory becomes a file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manifest-test-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(home);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "old.txt"), "old");
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
      [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=test@openclaw.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ],
    ]) {
      const result = await runCommandWithTimeout(["git", "-C", workspace, ...args], {
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(0);
    }
    const base = await runCommandWithTimeout(["git", "-C", workspace, "rev-parse", "HEAD"], {
      timeoutMs: 10_000,
    });
    expect(base.code).toBe(0);
    const env = { ...process.env, HOME: home };
    const initial = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        base.stdout.trim(),
        "eligible",
        "",
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(initial.code).toBe(0);

    await fs.rm(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src"), "replacement");
    const current = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        workspace,
        base.stdout.trim(),
        "eligible",
        initial.stdout.trim().slice("sha256:".length),
      ],
      { timeoutMs: 10_000, baseEnv: env },
    );
    expect(current.code).toBe(0);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(
          home,
          ".openclaw-worker",
          "manifests",
          current.stdout.trim().slice("sha256:".length) + ".json",
        ),
        "utf8",
      ),
    ) as { entries: Array<{ path: string; type: string }> };
    expect(manifest.entries).toContainEqual(expect.objectContaining({ path: "src", type: "file" }));
    expect(manifest.entries.some((entry) => entry.path === "src/old.txt")).toBe(false);
  });
});
