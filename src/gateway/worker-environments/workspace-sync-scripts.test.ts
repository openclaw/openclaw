import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-sync-scripts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quiescence-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  let workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  const extraProcessPath = path.join(root, "extra-process.txt");
  await fs.mkdir(home);
  await fs.mkdir(workspace);
  workspace = await fs.realpath(workspace);
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "ps"),
    '#!/bin/sh\ncase "$*" in\n  *"stat=,lstart= -p"*) printf "T Tue Jul 15 08:00:00 2026\\n" ;;\n  *"lstart= -p"*) printf "Tue Jul 15 08:00:00 2026\\n" ;;\n  *) printf "%s %s %s S Tue Jul 15 08:00:00 2026\\n" "$$" "$PPID" "$(id -u)"; if [ -f "$OPENCLAW_TEST_PS_EXTRA" ]; then cat "$OPENCLAW_TEST_PS_EXTRA"; fi ;;\nesac\n',
  );
  await fs.chmod(path.join(bin, "ps"), 0o755);
  return {
    home,
    workspace,
    extraProcessPath,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_TEST_PS_EXTRA: extraProcessPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  };
}

async function quiesce(input: Awaited<ReturnType<typeof fixture>>) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_QUIESCE_JS, input.workspace, "10000"],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  const match = /^quiesced ([a-f0-9]{32})\n$/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

function leasePath(home: string, workspace: string, nonce: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(home, ".openclaw-worker", "quiescence", `${key}.${nonce}.json`);
}

async function resume(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, input.workspace, nonce],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
}

async function renew(input: Awaited<ReturnType<typeof fixture>>, nonce: string) {
  const result = await runCommandWithTimeout(
    [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce, "20000"],
    { timeoutMs: 10_000, baseEnv: input.env },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`renewed ${nonce}\n`);
}

describe("remote workspace quiescence scripts", () => {
  it("excludes its ps scanner and terminates its watchdog on resume", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const lease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, nonce), "utf8"),
    ) as {
      watchdog: { pid: number; start: string };
    };

    await resume(input, nonce);

    await expect(fs.access(leasePath(input.home, input.workspace, nonce))).rejects.toThrow();
    await vi.waitFor(() => {
      expect(() => process.kill(lease.watchdog.pid, 0)).toThrow();
    });
  });

  it("recovers a prior nonce without letting its watchdog own the next lease", async () => {
    const input = await fixture();
    const firstNonce = await quiesce(input);
    const firstLease = JSON.parse(
      await fs.readFile(leasePath(input.home, input.workspace, firstNonce), "utf8"),
    ) as { watchdog: { pid: number; start: string } };

    const secondNonce = await quiesce(input);

    expect(secondNonce).not.toBe(firstNonce);
    await expect(fs.access(leasePath(input.home, input.workspace, firstNonce))).rejects.toThrow();
    await expect(
      fs.access(leasePath(input.home, input.workspace, secondNonce)),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(() => process.kill(firstLease.watchdog.pid, 0)).toThrow();
    });
    await resume(input, secondNonce);
  });

  it("proves the lease is active and renews its watchdog deadline", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    const leaseFile = leasePath(input.home, input.workspace, nonce);
    const before = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };

    await renew(input, nonce);

    const after = JSON.parse(await fs.readFile(leaseFile, "utf8")) as {
      expiresAtMs: number;
      watchdog: { pid: number; start: string };
    };
    expect(after.expiresAtMs).toBeGreaterThan(before.expiresAtMs);
    expect(after.watchdog).toEqual(before.watchdog);
    expect(() => process.kill(after.watchdog.pid, 0)).not.toThrow();
    await resume(input, nonce);
  });

  it("rejects a writable process that appeared after the workspace was quiesced", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    await fs.writeFile(
      input.extraProcessPath,
      `999999 1 ${process.getuid?.() ?? 0} S Tue Jul 15 08:01:00 2026\n`,
    );

    const heartbeat = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        input.workspace,
        nonce,
        "20000",
        "heartbeat",
      ],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(heartbeat.code).toBe(0);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
      { timeoutMs: 10_000, baseEnv: input.env },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("new writable process");
    await fs.rm(input.extraProcessPath);
    await resume(input, nonce);
  });

  it("fails closed when the watchdog lease no longer exists", async () => {
    const input = await fixture();
    const nonce = await quiesce(input);
    await resume(input, nonce);

    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS, input.workspace, nonce],
      { timeoutMs: 10_000, baseEnv: input.env },
    );
    expect(result.code).not.toBe(0);
  });

  it("bounds every ps probe in the quiesce script with a timeout + SIGKILL", () => {
    // The watchdog runs serialized source via watchdogMain.toString() in a
    // separate Node child process, so it cannot close over parent-scope
    // constants. Regression guard for a ReferenceError that would otherwise
    // only surface at watchdog expiry time.
    expect(REMOTE_WORKSPACE_QUIESCE_JS).toMatch(/PS_TIMEOUT_MS\s*=\s*5000/);
    const watchdogMatches = REMOTE_WORKSPACE_QUIESCE_JS.match(
      /function watchdogMain\([^)]*\)\s*\{[\s\S]*?\n\}/,
    );
    expect(watchdogMatches).not.toBeNull();
    expect(watchdogMatches![0]).toMatch(/PS_TIMEOUT_MS\s*=\s*5000/);
    // Every execFileSync("ps", ...) call site in the quiesce script must
    // carry BOTH the timeout option AND killSignal: "SIGKILL". SIGKILL is
    // required because the default (SIGTERM) can be trapped by adversarial
    // or unresponsive children, defeating the timeout and leaving the
    // caller hung on a blocked pipe (regression found by ClawSweeper).
    const psCallSites = REMOTE_WORKSPACE_QUIESCE_JS.split('execFileSync("ps"').length - 1;
    expect(psCallSites).toBeGreaterThan(0);
    expect(REMOTE_WORKSPACE_QUIESCE_JS.split('execFileSync("ps"').length - 1).toBe(
      REMOTE_WORKSPACE_QUIESCE_JS.split("timeout: PS_TIMEOUT_MS").length - 1,
    );
    expect(REMOTE_WORKSPACE_QUIESCE_JS.split('execFileSync("ps"').length - 1).toBe(
      REMOTE_WORKSPACE_QUIESCE_JS.split('killSignal: "SIGKILL"').length - 1,
    );
  });

  it("bounds every ps probe in the renew script with a timeout + SIGKILL", () => {
    // ClawSweeper P1: an unbounded subprocess in workspace quiescence can
    // stall active remote workspace RENEWAL behavior. The renew script
    // invokes `ps` twice (processStatus for individual pids, processes for
    // the full snapshot in final mode). Both must carry the timeout and
    // SIGKILL kill signal so a hung `ps` cannot stall a renewal.
    expect(REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS).toMatch(/PS_TIMEOUT_MS\s*=\s*5000/);
    const psCallSites = REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS.split('execFileSync("ps"').length - 1;
    expect(psCallSites).toBeGreaterThan(0);
    expect(REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS.split('execFileSync("ps"').length - 1).toBe(
      REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS.split("timeout: PS_TIMEOUT_MS").length - 1,
    );
    expect(REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS.split('execFileSync("ps"').length - 1).toBe(
      REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS.split('killSignal: "SIGKILL"').length - 1,
    );
  });

  it("bounds every ps probe in the resume script with a timeout + SIGKILL", () => {
    // ClawSweeper P1: an unbounded subprocess in workspace quiescence can
    // stall active remote workspace RESUME behavior. The resume script
    // invokes `ps` once (identity for each frozen process + watchdog
    // termination probe). It must carry the timeout and SIGKILL kill signal
    // so a hung `ps` cannot stall a resume.
    expect(REMOTE_WORKSPACE_RESUME_JS).toMatch(/PS_TIMEOUT_MS\s*=\s*5000/);
    const psCallSites = REMOTE_WORKSPACE_RESUME_JS.split('execFileSync("ps"').length - 1;
    expect(psCallSites).toBeGreaterThan(0);
    expect(REMOTE_WORKSPACE_RESUME_JS.split('execFileSync("ps"').length - 1).toBe(
      REMOTE_WORKSPACE_RESUME_JS.split("timeout: PS_TIMEOUT_MS").length - 1,
    );
    expect(REMOTE_WORKSPACE_RESUME_JS.split('execFileSync("ps"').length - 1).toBe(
      REMOTE_WORKSPACE_RESUME_JS.split('killSignal: "SIGKILL"').length - 1,
    );
  });

  it("runtime proof: renew fails fast when ps hangs (SIGKILL runtime proof)", async () => {
    // Live runtime proof for the renew script: when `ps` hangs (e.g. an
    // adversarial /proc reader or D-state process trapping SIGTERM), the
    // per-call timeout must fire and SIGKILL the child so renewal does not
    // stall waiting on the blocked pipe. Without the killSignal, the
    // default SIGTERM would be trapped and the renewal would hang.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-renew-hang-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    const leaseDir = path.join(home, ".openclaw-worker", "quiescence");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(leaseDir, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(bin, "ps"),
      '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n',
    );
    await fs.chmod(path.join(bin, "ps"), 0o755);

    const workspaceKey = createHash("sha256").update(workspace).digest("hex");
    const nonce = "a".repeat(32);
    const leaseFile = path.join(leaseDir, `${workspaceKey}.${nonce}.json`);
    const lease = {
      version: 1,
      nonce,
      processes: [{ pid: 999999, start: "Mon Jan  1 00:00:00 2024" }],
      watchdog: { pid: 999998, start: "Mon Jan  1 00:00:00 2024" },
      expiresAtMs: Date.now() + 60_000,
    };
    await fs.writeFile(leaseFile, JSON.stringify(lease));

    const start = Date.now();
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
        workspace,
        nonce,
        "20000",
        "heartbeat",
      ],
      {
        timeoutMs: 15_000,
        baseEnv: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    const elapsed = Date.now() - start;

    // The renewal must fail (non-zero exit) because processStatus timed out
    // and propagated as an error.
    expect(result.code).not.toBe(0);
    // Must return well under the 15s outer guard.
    expect(elapsed).toBeLessThan(10_000);
    // Must have actually waited at least ~5s (the PS_TIMEOUT_MS deadline).
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
  }, 20_000);

  it("runtime proof: resume fails fast when ps hangs (SIGKILL runtime proof)", async () => {
    // Live runtime proof for the resume script: when `ps` hangs, the
    // per-call timeout must fire and SIGKILL the child so resume does not
    // stall on the blocked pipe. Without the killSignal, the default
    // SIGTERM would be trapped and resume would hang.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-resume-hang-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    const leaseDir = path.join(home, ".openclaw-worker", "quiescence");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(leaseDir, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(bin, "ps"),
      '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n',
    );
    await fs.chmod(path.join(bin, "ps"), 0o755);

    const workspaceKey = createHash("sha256").update(workspace).digest("hex");
    const nonce = "a".repeat(32);
    const leaseFile = path.join(leaseDir, `${workspaceKey}.${nonce}.json`);
    const lease = {
      version: 1,
      nonce,
      processes: [{ pid: 999999, start: "Mon Jan  1 00:00:00 2024" }],
      watchdog: { pid: 999998, start: "Mon Jan  1 00:00:00 2024" },
      expiresAtMs: Date.now() + 60_000,
    };
    await fs.writeFile(leaseFile, JSON.stringify(lease));

    const start = Date.now();
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", REMOTE_WORKSPACE_RESUME_JS, workspace, nonce],
      {
        timeoutMs: 15_000,
        baseEnv: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    const elapsed = Date.now() - start;

    // Resume must fail (non-zero exit) because identity() timed out and
    // propagated as an error.
    expect(result.code).not.toBe(0);
    // Must return well under the 15s outer guard.
    expect(elapsed).toBeLessThan(10_000);
    // Must have actually waited at least ~5s (the PS_TIMEOUT_MS deadline).
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
  }, 20_000);

  it("runtime proof: serialized watchdog fails fast when ps hangs", async () => {
    // Live runtime proof requested by ClawSweeper: the watchdog runs in a
    // separate Node child process with serialized source via
    // watchdogMain.toString(). Any closure capture of parent-scope
    // constants would be a ReferenceError only at watchdog expiry time.
    //
    // This test verifies the serialized watchdog:
    //   1. Has its own PS_TIMEOUT_MS = 5000 inside watchdogMain.
    //   2. Every execFileSync("ps", ...) call site carries the timeout.
    //   3. When ps hangs, the watchdog fails fast at the 5s deadline
    //      instead of hanging the quiesce workflow indefinitely.
    //
    // We extract watchdogMain's source, wrap it in the same IIFE the
    // production code uses (`(fn)(argv1, argv2)`), and run it in a fresh
    // Node child process with a fake `ps` on PATH that hangs forever.
    // The outer 30s guard ensures we never hang the test suite.
    const watchdogMatch = REMOTE_WORKSPACE_QUIESCE_JS.match(
      /function watchdogMain\([^)]*\)\s*\{[\s\S]*?\n\}/,
    );
    expect(watchdogMatch).not.toBeNull();
    const watchdogSrc = watchdogMatch![0]!;
    // Must declare PS_TIMEOUT_MS inside watchdogMain.
    expect(watchdogSrc).toMatch(/PS_TIMEOUT_MS\s*=\s*5000/);
    // Every ps call site must carry the timeout option.
    const psCallSites = watchdogSrc.split('execFileSync("ps"').length - 1;
    expect(psCallSites).toBeGreaterThan(0);
    expect(watchdogSrc.split('execFileSync("ps"').length - 1).toBe(
      watchdogSrc.split("timeout: PS_TIMEOUT_MS").length - 1,
    );

    // Now run watchdogMain in a real Node child with a fake hanging ps.
    // The watchdog reads its leasePath from argv[1] and nonce from argv[2].
    // We point it at a temp lease file with an expired lease containing
    // a fake pid; the watchdog will try to processIdentity() that pid,
    // hit our fake ps, time out at 5s, and exit with code 1.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watchdog-hang-"));
    roots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const bin = path.join(root, "bin");
    const leaseDir = path.join(home, ".openclaw-worker", "quiescence");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(leaseDir, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(bin, "ps"),
      '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n',
    );
    await fs.chmod(path.join(bin, "ps"), 0o755);

    // Write an expired lease so watchdog immediately tries to resume
    // processes (which calls processIdentity -> ps).
    const workspaceKey = createHash("sha256").update(workspace).digest("hex");
    const nonce = "a".repeat(32);
    const leaseFile = path.join(leaseDir, `${workspaceKey}.${nonce}.json`);
    // expiresAtMs in the past forces immediate resume attempt.
    const lease = {
      version: 1,
      nonce,
      processes: [{ pid: 999999, start: "Mon Jan  1 00:00:00 2024" }],
      watchdog: null,
      expiresAtMs: 1,
    };
    await fs.writeFile(leaseFile, JSON.stringify(lease));

    // Wrap the watchdog source in the same IIFE used in production.
    const wrappedSrc = `"use strict";\n(${watchdogSrc})(process.argv[1], process.argv[2]);`;

    const start = Date.now();
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", wrappedSrc, leaseFile, nonce],
      {
        timeoutMs: 15_000,
        baseEnv: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    const elapsed = Date.now() - start;
    // The watchdog must fail (non-zero exit) because the processIdentity
    // call timed out and propagated as an error. Without the per-call
    // timeout, this would hang until the 15s outer guard fired.
    expect(result.code).not.toBe(0);
    // Must return well under the 15s outer guard.
    expect(elapsed).toBeLessThan(10_000);
    // Must have actually waited at least ~5s (the PS_TIMEOUT_MS deadline).
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
  }, 20_000);
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
    const legacyProducerLocale = "en-US";
    legacyCanonical.entries.sort((left, right) =>
      left.path.localeCompare(right.path, legacyProducerLocale),
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
        legacyProducerLocale,
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
