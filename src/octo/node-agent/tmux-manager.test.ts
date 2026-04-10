// Octopus Orchestrator — TmuxManager live integration tests (M1-10; M1-11 added enumerateExisting tests).
//
// These tests spawn REAL tmux sessions on the default tmux server and
// must clean up after themselves — a leaked session pollutes the
// developer's machine. Session-name scoping uses a per-test-run prefix
// so post-run cleanup can sweep leftovers deterministically.
//
// The whole suite is gated on tmux availability so a CI box without
// tmux does not fail.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TmuxError, TmuxManager } from "./tmux-manager.ts";

const execFileAsync = promisify(execFile);

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TMUX_AVAILABLE = hasTmux();

// Per-test-run prefix so cleanup can find our sessions even after a
// mid-test crash. Keep it short enough that tmux accepts it easily but
// unique enough to never collide with anything else.
const RUN_PREFIX = `octo-m1-10-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function nameFor(tag: string): string {
  return `${RUN_PREFIX}-${tag}`;
}

async function rawListSessionNames(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function sweep(prefix: string): Promise<void> {
  const names = await rawListSessionNames();
  for (const n of names) {
    if (n.startsWith(prefix)) {
      try {
        await execFileAsync("tmux", ["kill-session", "-t", n]);
      } catch {
        // best effort — swallow
      }
    }
  }
}

describe.skipIf(!TMUX_AVAILABLE)("TmuxManager (live tmux integration)", () => {
  const mgr = new TmuxManager();
  const tempDirs: string[] = [];

  beforeAll(() => {
    // Nothing to set up — the sweep in afterEach/afterAll is authoritative.
  });

  afterEach(async () => {
    await sweep(RUN_PREFIX);
  });

  afterAll(async () => {
    await sweep(RUN_PREFIX);
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
  });

  function mkTempDir(tag: string): string {
    const d = mkdtempSync(join(tmpdir(), `tmux-mgr-${tag}-`));
    tempDirs.push(d);
    return d;
  }

  it("roundtrip: create, list includes, kill, list excludes (acceptance)", async () => {
    const name = nameFor("roundtrip");
    const cwd = mkTempDir("rt");

    const returned = await mgr.createSession(name, "sleep 30", cwd);
    expect(returned).toBe(name);

    // 100ms grace for tmux to register the session.
    await new Promise((r) => setTimeout(r, 100));

    const afterCreate = await mgr.listSessions();
    expect(afterCreate).toContain(name);

    const killed = await mgr.killSession(name);
    expect(killed).toBe(true);

    const afterKill = await mgr.listSessions();
    expect(afterKill).not.toContain(name);
  });

  it("createSession returns the input name unchanged", async () => {
    const name = nameFor("returns");
    const cwd = mkTempDir("ret");
    const returned = await mgr.createSession(name, "sleep 10", cwd);
    expect(returned).toBe(name);
  });

  it.each([
    ["empty", ""],
    ["dot", `${RUN_PREFIX}.bad`],
    ["colon", `${RUN_PREFIX}:bad`],
    ["newline", `${RUN_PREFIX}\nbad`],
    ["space", `${RUN_PREFIX} bad`],
    ["control", `${RUN_PREFIX}\x01bad`],
  ])("createSession rejects invalid name: %s", async (_label, bad) => {
    const cwd = mkTempDir("badname");
    await expect(mgr.createSession(bad, "sleep 10", cwd)).rejects.toThrow();
  });

  it("createSession throws a clear error for a non-existent cwd", async () => {
    const name = nameFor("badcwd");
    const bogus = `/tmp/nonexistent-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    await expect(mgr.createSession(name, "sleep 10", bogus)).rejects.toThrow(
      /not accessible|not a directory/,
    );
  });

  it("killSession returns false for a session that does not exist (idempotent)", async () => {
    const name = nameFor("ghost");
    const result = await mgr.killSession(name);
    expect(result).toBe(false);
  });

  it("two concurrent createSession calls both succeed and are listed and killed", async () => {
    const a = nameFor("concA");
    const b = nameFor("concB");
    const cwd = mkTempDir("conc");

    const [ra, rb] = await Promise.all([
      mgr.createSession(a, "sleep 30", cwd),
      mgr.createSession(b, "sleep 30", cwd),
    ]);
    expect(ra).toBe(a);
    expect(rb).toBe(b);

    await new Promise((r) => setTimeout(r, 100));
    const list = await mgr.listSessions();
    expect(list).toContain(a);
    expect(list).toContain(b);

    const [ka, kb] = await Promise.all([mgr.killSession(a), mgr.killSession(b)]);
    expect(ka).toBe(true);
    expect(kb).toBe(true);

    const after = await mgr.listSessions();
    expect(after).not.toContain(a);
    expect(after).not.toContain(b);
  });

  it("preserves verbatim session names with underscores and digits", async () => {
    const name = nameFor("name_with_123_bits");
    const cwd = mkTempDir("verb");
    await mgr.createSession(name, "sleep 10", cwd);
    await new Promise((r) => setTimeout(r, 100));
    const list = await mgr.listSessions();
    expect(list).toContain(name);
  });

  it("createSession starts the command in the given cwd", async () => {
    const name = nameFor("cwdcheck");
    const cwd = mkTempDir("cwdcheck");
    const outFile = join(cwd, "pwd-output.txt");

    // Use /bin/sh -c so we get shell redirection. tmux will exec
    // /bin/sh directly (no outer shell).
    await mgr.createSession(name, `/bin/sh -c "pwd > '${outFile}'; sleep 5"`, cwd);

    // Give the shell a moment to write the file.
    await new Promise((r) => setTimeout(r, 300));

    expect(existsSync(outFile)).toBe(true);
    const contents = readFileSync(outFile, "utf8").trim();
    // On macOS /tmp is a symlink to /private/tmp; allow either form.
    expect(contents.endsWith(cwd) || contents === cwd || cwd.endsWith(contents)).toBe(true);
  });

  describe("enumerateExisting (M1-11)", () => {
    it("enumerate returns sessions including ones not created via this manager instance", async () => {
      // Create a session using a raw tmux command (not via the manager) to
      // prove enumerateExisting() sees sessions regardless of provenance.
      const name = nameFor("enum-raw");
      const cwd = mkTempDir("enum-raw");
      await execFileAsync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, "sleep 30"]);
      await new Promise((r) => setTimeout(r, 100));

      const sessions = await mgr.enumerateExisting();
      const found = sessions.find((s) => s.name === name);
      expect(found).toBeDefined();
      // Do NOT assert array length — other dev sessions may exist on the box.
    });

    it("enumerate returns structured info: name, created_ts, cwd, windows", async () => {
      const name = nameFor("enum-struct");
      const cwd = mkTempDir("enum-struct");
      await mgr.createSession(name, "sleep 30", cwd);
      await new Promise((r) => setTimeout(r, 150));

      const sessions = await mgr.enumerateExisting();
      const found = sessions.find((s) => s.name === name);
      expect(found).toBeDefined();
      if (!found) {
        return;
      }

      expect(found.name).toBe(name);

      // created_ts: a plausible unix-ms timestamp after 2023-11 and not in the future.
      expect(typeof found.created_ts).toBe("number");
      expect(found.created_ts!).toBeGreaterThan(1_700_000_000_000);
      expect(found.created_ts!).toBeLessThanOrEqual(Date.now() + 1000);

      // cwd: handle macOS /tmp -> /private/tmp symlink. Compare against
      // both the raw and realpath-resolved form.
      expect(typeof found.cwd).toBe("string");
      const expectedCwd = resolve(cwd);
      const expectedCwdReal = (() => {
        try {
          return realpathSync(cwd);
        } catch {
          return expectedCwd;
        }
      })();
      const foundCwdReal = (() => {
        try {
          return realpathSync(found.cwd as string);
        } catch {
          return found.cwd as string;
        }
      })();
      expect(
        found.cwd === expectedCwd ||
          found.cwd === expectedCwdReal ||
          foundCwdReal === expectedCwdReal,
      ).toBe(true);

      // windows: positive integer.
      expect(typeof found.windows).toBe("number");
      expect(found.windows!).toBeGreaterThan(0);
      expect(Number.isInteger(found.windows!)).toBe(true);
    });

    it("enumerate handles a session with a complex name containing underscores and digits", async () => {
      const name = nameFor("enum_complex_name_42-foo_bar-123");
      const cwd = mkTempDir("enum-complex");
      await mgr.createSession(name, "sleep 30", cwd);
      await new Promise((r) => setTimeout(r, 100));

      const sessions = await mgr.enumerateExisting();
      const found = sessions.find((s) => s.name === name);
      expect(found).toBeDefined();
      expect(found?.name).toBe(name);
    });

    it("enumerate parses created_ts into unix millis (within ~5s of now)", async () => {
      const name = nameFor("enum-ts");
      const cwd = mkTempDir("enum-ts");
      const before = Date.now();
      await mgr.createSession(name, "sleep 30", cwd);
      await new Promise((r) => setTimeout(r, 100));

      const sessions = await mgr.enumerateExisting();
      const found = sessions.find((s) => s.name === name);
      expect(found).toBeDefined();
      expect(typeof found?.created_ts).toBe("number");
      // tmux session_created is second-precision, so allow some slack.
      // |created_ts - before| should be within ~5s.
      expect(Math.abs((found!.created_ts as number) - before)).toBeLessThan(5000);
    });

    it("enumerate coexists with a concurrent createSession without erroring", async () => {
      const a = nameFor("enum-concA");
      const b = nameFor("enum-concB");
      const cwd = mkTempDir("enum-conc");

      // Seed one session so enumerate has something to list.
      await mgr.createSession(a, "sleep 30", cwd);
      await new Promise((r) => setTimeout(r, 50));

      const [enumResult, createResult] = await Promise.all([
        mgr.enumerateExisting(),
        mgr.createSession(b, "sleep 30", cwd),
      ]);
      expect(Array.isArray(enumResult)).toBe(true);
      expect(createResult).toBe(b);

      // After both settle, a second enumerate should see both.
      await new Promise((r) => setTimeout(r, 100));
      const second = await mgr.enumerateExisting();
      expect(second.find((s) => s.name === a)).toBeDefined();
      expect(second.find((s) => s.name === b)).toBeDefined();
    });
  });

  it("TmuxError carries stderr, code, and command when tmux rejects a real request", async () => {
    // Force a real tmux failure by using a bogus tmux binary path,
    // which produces an ENOENT-shaped error wrapped by TmuxManager.
    const bogus = new TmuxManager({ tmuxBin: "/nonexistent/tmux-binary-xyz" });
    let caught: unknown;
    try {
      await bogus.listSessions();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TmuxError);
    const tmuxErr = caught as TmuxError;
    expect(Array.isArray(tmuxErr.command)).toBe(true);
    expect(tmuxErr.command[0]).toBe("/nonexistent/tmux-binary-xyz");
    expect(typeof tmuxErr.stderr).toBe("string");
    expect(typeof tmuxErr.code).toBe("number");
  });
});
