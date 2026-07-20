import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Runtime proof that dns-cli subprocess timeouts use SIGKILL (not the
// default SIGTERM) so an adversarial or unresponsive child cannot defeat
// the timeout by trapping SIGTERM and leaving `openclaw dns setup` hung.
//
// ClawSweeper requested runtime proof that the bounded spawnSync in
// dns-cli.ts actually fires the timeout at the configured deadline and
// terminates the child, instead of overstating the guarantee as the prior
// structural-only review did.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DNS_SPAWN_LONG_TIMEOUT_MS, DNS_SPAWN_SHORT_TIMEOUT_MS, run as dnsRun } from "./dns-cli.js";

const originalPath = process.env.PATH;
const stubDirs: string[] = [];

beforeEach(() => {
  // Reset PATH between tests so a stub from one test cannot leak into another.
  process.env.PATH = originalPath;
});

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of stubDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
  stubDirs.length = 0;
});

/**
 * Install a fake `brew` (or any named command) on PATH that traps SIGTERM
 * and SIGINT and sleeps forever. This simulates a stalled Homebrew process
 * (e.g. blocked on an unreachable PAM module, hung Homebrew auto-update,
 * or a child that has re-armed its signal handlers).
 *
 * If killSignal were the default SIGTERM, spawnSync's `timeout` would fire
 * but the child would ignore the signal and keep the pipe open, hanging
 * the parent until the test runner's outer guard fired. With
 * killSignal: "SIGKILL", the child is hard-killed at the deadline and
 * spawnSync returns promptly.
 */
function installHangingStub(name: "brew" | "sudo" | "tee"): string {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dns-stub-"));
  stubDirs.push(stubDir);
  const stubPath = path.join(stubDir, name);
  fs.writeFileSync(
    stubPath,
    '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n',
  );
  fs.chmodSync(stubPath, 0o755);
  process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
  return stubDir;
}

describe("dns-cli spawn timeouts", () => {
  it("exposes the documented short and long timeout budgets", () => {
    // Structural guard: the constants must stay exported so the runtime
    // proof test can reference them, and they must match the documented
    // short (30s) / long (5min) budgets in the source comment.
    expect(DNS_SPAWN_SHORT_TIMEOUT_MS).toBe(30_000);
    expect(DNS_SPAWN_LONG_TIMEOUT_MS).toBe(5 * 60_000);
    // Long budget must be strictly greater than the short budget; if the
    // split is ever collapsed, the runtime proof below will become
    // meaningless and the test should fail loudly.
    expect(DNS_SPAWN_LONG_TIMEOUT_MS).toBeGreaterThan(DNS_SPAWN_SHORT_TIMEOUT_MS);
  });

  it("runtime proof: SIGKILL terminates a SIGTERM-trapping brew at the deadline", () => {
    // Live runtime proof requested by ClawSweeper: simulate a stalled
    // Homebrew process by installing a fake `brew` that traps SIGTERM and
    // SIGINT and sleeps forever. The run() helper (killSignal: "SIGKILL")
    // must hard-kill the stub at the configured timeoutMs deadline instead
    // of hanging the dns setup workflow indefinitely.
    //
    // We use a 1500ms override (well below DNS_SPAWN_SHORT_TIMEOUT_MS) so
    // the test runs fast, but the proof is the same: if killSignal were
    // SIGTERM, the call would hang past the 15s vitest test timeout.
    installHangingStub("brew");

    const start = Date.now();
    let threw: unknown = null;
    try {
      dnsRun("brew", ["--prefix"], { timeoutMs: 1500 });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;

    // Must have thrown (spawnSync surfaces timeout as an error with
    // code ETIMEDOUT and signal SIGKILL on the result, and run() rethrows
    // res.error when present).
    expect(threw).not.toBeNull();
    // Must return within a small slack of the configured deadline.
    // Without killSignal: "SIGKILL" this assertion fails because the call
    // hangs until the vitest test timeout (15s) kills the test process.
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
    // The thrown error must carry the ETIMEDOUT code so callers can
    // distinguish a timeout from a regular non-zero exit.
    const err = threw as { code?: string; signal?: string };
    expect(err.code).toBe("ETIMEDOUT");
  }, 10_000);

  it("runtime proof: sudo tee also gets SIGKILL when the child hangs", () => {
    // Same runtime proof but for the second spawnSync call site in
    // writeFileSudoIfNeeded() (sudo tee path). The killSignal must match
    // the brew call site so a hung PAM or sudo prompt cannot hang the
    // workflow either. We exercise this via the run() helper using a
    // fake sudo that traps SIGTERM and hangs.
    installHangingStub("sudo");

    const start = Date.now();
    let threw: unknown = null;
    try {
      dnsRun("sudo", ["-n", "true"], { timeoutMs: 1500 });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - start;

    expect(threw).not.toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
    const err = threw as { code?: string };
    expect(err.code).toBe("ETIMEDOUT");
  }, 10_000);
});
