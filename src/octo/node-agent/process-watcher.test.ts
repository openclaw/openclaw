// Octopus Orchestrator — ProcessWatcher live integration tests (M1-12).
//
// These tests spawn REAL tmux sessions via TmuxManager and exercise the
// sentinel-file contract end-to-end. They must clean up after
// themselves — both tmux sessions and sentinel files — since a leaked
// session or file pollutes the developer's machine.
//
// The whole suite is gated on tmux availability so a CI box without
// tmux does not fail.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProcessWatcher, type ProcessWatcherEvent } from "./process-watcher.ts";
import { TmuxManager } from "./tmux-manager.ts";

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

// Per-test-run prefix for session-name scoping.
const RUN_PREFIX = `octo-m1-12-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
        // best effort
      }
    }
  }
}

/**
 * Collect the next ProcessWatcher event of any type, or reject after
 * `timeoutMs`. Uses `once` so there is no listener leak on success.
 */
function nextEvent(watcher: ProcessWatcher, timeoutMs: number): Promise<ProcessWatcherEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off("process", onEvent);
      reject(new Error(`timed out waiting for process event after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvent = (evt: ProcessWatcherEvent): void => {
      clearTimeout(timer);
      resolve(evt);
    };
    watcher.once("process", onEvent);
  });
}

describe.skipIf(!TMUX_AVAILABLE)("ProcessWatcher (live tmux integration)", () => {
  const mgr = new TmuxManager();
  const tempDirs: string[] = [];
  let activeWatchers: ProcessWatcher[] = [];

  function mkTempDir(tag: string): string {
    const d = mkdtempSync(join(tmpdir(), `proc-watcher-${tag}-`));
    tempDirs.push(d);
    return d;
  }

  /**
   * Build a shell script at `<tmpDir>/<tag>.sh` that runs `bodyLines`
   * and then writes `$?` to the given sentinel path. Returns the
   * absolute path of the script (to be passed as the tmux cmd).
   *
   * We use a script file (instead of `/bin/sh -c "..."`) to sidestep
   * the tmux/shell quoting drama entirely.
   */
  function mkWrappedScript(
    tmpDir: string,
    tag: string,
    bodyLines: string[],
    sentinelPath: string,
  ): string {
    const scriptPath = join(tmpDir, `${tag}.sh`);
    // Run the body in a subshell so a body-level `exit N` terminates
    // the subshell only and we can capture $? before writing the
    // sentinel and exiting the outer script.
    const body = bodyLines.join("\n");
    const script = `#!/bin/sh
set +e
(
${body}
)
_rc=$?
printf '%s\\n' "$_rc" > ${sentinelPath}
exit $_rc
`;
    writeFileSync(scriptPath, script);
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  function trackWatcher(w: ProcessWatcher): ProcessWatcher {
    activeWatchers.push(w);
    return w;
  }

  afterEach(async () => {
    for (const w of activeWatchers) {
      try {
        w.stop();
      } catch {
        // swallow
      }
    }
    activeWatchers = [];
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

  it("detects exit code 0 and emits 'completed'", async () => {
    const name = nameFor("ok");
    const cwd = mkTempDir("ok");
    const sentinelPath = join(cwd, "exit.sentinel");
    const script = mkWrappedScript(cwd, "ok", ["sleep 0.1", "exit 0"], sentinelPath);

    await mgr.createSession(name, script, cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    watcher.watch({
      arm_id: "arm-ok",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });

    const evt = await nextEvent(watcher, 5000);
    expect(evt.type).toBe("completed");
    if (evt.type === "completed") {
      expect(evt.exit_code).toBe(0);
      expect(evt.arm_id).toBe("arm-ok");
      expect(evt.session_name).toBe(name);
      expect(typeof evt.ts).toBe("string");
    }
    expect(watcher.watchedCount()).toBe(0);
    expect(watcher.isRunning()).toBe(false);
  });

  it("detects exit code 7 and emits 'failed' with exit_code: 7 (M1-12 acceptance)", async () => {
    const name = nameFor("exit7");
    const cwd = mkTempDir("exit7");
    const sentinelPath = join(cwd, "exit.sentinel");
    const script = mkWrappedScript(cwd, "exit7", ["sleep 0.1", "exit 7"], sentinelPath);

    await mgr.createSession(name, script, cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    watcher.watch({
      arm_id: "arm-exit7",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });

    const evt = await nextEvent(watcher, 5000);
    expect(evt.type).toBe("failed");
    if (evt.type === "failed") {
      expect(evt.exit_code).toBe(7);
      expect(evt.arm_id).toBe("arm-exit7");
      expect(evt.session_name).toBe(name);
      expect(evt.reason).toContain("exit_code_7");
    }
  });

  it("detects multiple concurrent targets independently", async () => {
    const cwd = mkTempDir("multi");
    const specs = [
      { tag: "a", code: 0, arm: "arm-multi-a" },
      { tag: "b", code: 3, arm: "arm-multi-b" },
      { tag: "c", code: 42, arm: "arm-multi-c" },
    ];

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    const received: ProcessWatcherEvent[] = [];
    const allReceived = new Promise<void>((resolve) => {
      watcher.on("process", (evt) => {
        received.push(evt);
        if (received.length === specs.length) {
          resolve();
        }
      });
    });

    for (const s of specs) {
      const sessionName = nameFor(`multi-${s.tag}`);
      const sentinelPath = join(cwd, `exit-${s.tag}.sentinel`);
      const script = mkWrappedScript(
        cwd,
        `multi-${s.tag}`,
        ["sleep 0.1", `exit ${s.code}`],
        sentinelPath,
      );
      await mgr.createSession(sessionName, script, cwd);
      watcher.watch({
        arm_id: s.arm,
        session_name: sessionName,
        exit_sentinel_path: sentinelPath,
      });
    }

    await Promise.race([
      allReceived,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error("timeout waiting for 3 events")), 5000),
      ),
    ]);

    expect(received).toHaveLength(3);
    const byArm = new Map(received.map((e) => [e.arm_id, e]));

    const a = byArm.get("arm-multi-a");
    expect(a?.type).toBe("completed");
    if (a?.type === "completed") {
      expect(a.exit_code).toBe(0);
    }

    const b = byArm.get("arm-multi-b");
    expect(b?.type).toBe("failed");
    if (b?.type === "failed") {
      expect(b.exit_code).toBe(3);
    }

    const c = byArm.get("arm-multi-c");
    expect(c?.type).toBe("failed");
    if (c?.type === "failed") {
      expect(c.exit_code).toBe(42);
    }

    expect(watcher.watchedCount()).toBe(0);
  });

  it("detects session-gone-without-sentinel as failed with exit_code null", async () => {
    const name = nameFor("abnormal");
    const cwd = mkTempDir("abnormal");
    // Sentinel path points to a file that will NEVER be written —
    // the session is killed out from under the wrapper.
    const sentinelPath = join(cwd, "exit.sentinel");
    // Start a plain sleep with NO wrapper, so there is no sentinel
    // writer at all. The session will be killed mid-sleep.
    await mgr.createSession(name, "sleep 30", cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    watcher.watch({
      arm_id: "arm-abnormal",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });

    // Give the watcher one poll to observe the session is live, then
    // kill it.
    await new Promise((r) => setTimeout(r, 150));
    await execFileAsync("tmux", ["kill-session", "-t", name]);

    const evt = await nextEvent(watcher, 5000);
    expect(evt.type).toBe("failed");
    if (evt.type === "failed") {
      expect(evt.exit_code).toBeNull();
      expect(evt.reason).toContain("session_terminated_no_sentinel");
    }
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("handles unparseable sentinel content", async () => {
    const cwd = mkTempDir("unparse");
    const sentinelPath = join(cwd, "exit.sentinel");
    // Write garbage to the sentinel BEFORE starting the watch so the
    // first poll picks it up immediately. The session doesn't actually
    // matter — just give it a long-running command and then kill it.
    writeFileSync(sentinelPath, "not a number\n");
    const name = nameFor("unparse");
    await mgr.createSession(name, "sleep 30", cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    watcher.watch({
      arm_id: "arm-unparse",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });

    const evt = await nextEvent(watcher, 5000);
    expect(evt.type).toBe("failed");
    if (evt.type === "failed") {
      expect(evt.exit_code).toBeNull();
      expect(evt.reason).toContain("sentinel_unparseable");
    }
  });

  it("unwatch removes a target without emitting", async () => {
    const name = nameFor("unwatch");
    const cwd = mkTempDir("unwatch");
    const sentinelPath = join(cwd, "exit.sentinel");
    const script = mkWrappedScript(cwd, "unwatch", ["sleep 0.2", "exit 5"], sentinelPath);
    await mgr.createSession(name, script, cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    const events: ProcessWatcherEvent[] = [];
    watcher.on("process", (evt) => events.push(evt));

    watcher.watch({
      arm_id: "arm-unwatch",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });
    watcher.unwatch("arm-unwatch");

    expect(watcher.watchedCount()).toBe(0);
    expect(watcher.isRunning()).toBe(false);

    // Wait long enough for the wrapped script to finish and write the
    // sentinel; no event should fire because we unwatched.
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toHaveLength(0);
  });

  it("stop() halts the loop and emits no further events", async () => {
    const name = nameFor("stop");
    const cwd = mkTempDir("stop");
    const sentinelPath = join(cwd, "exit.sentinel");
    const script = mkWrappedScript(cwd, "stop", ["sleep 0.2", "exit 9"], sentinelPath);
    await mgr.createSession(name, script, cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 50 }));
    const events: ProcessWatcherEvent[] = [];
    watcher.on("process", (evt) => events.push(evt));
    watcher.watch({
      arm_id: "arm-stop",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });
    expect(watcher.isRunning()).toBe(true);

    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
    expect(watcher.watchedCount()).toBe(0);

    await new Promise((r) => setTimeout(r, 500));
    expect(events).toHaveLength(0);
  });

  it("newly constructed watcher has isRunning() === false", () => {
    const watcher = trackWatcher(new ProcessWatcher());
    expect(watcher.isRunning()).toBe(false);
    expect(watcher.watchedCount()).toBe(0);
  });

  it("respects the pollIntervalMs option", async () => {
    const name = nameFor("poll");
    const cwd = mkTempDir("poll");
    const sentinelPath = join(cwd, "exit.sentinel");
    // Write the sentinel BEFORE starting the watch so the first poll
    // fires the event immediately. We then measure how long until the
    // event is received for a fast (25ms) and a slow (400ms) watcher.
    writeFileSync(sentinelPath, "0\n");
    await mgr.createSession(name, "sleep 30", cwd);

    const watcher = trackWatcher(new ProcessWatcher({ pollIntervalMs: 25 }));
    const start = Date.now();
    watcher.watch({
      arm_id: "arm-poll",
      session_name: name,
      exit_sentinel_path: sentinelPath,
    });
    const evt = await nextEvent(watcher, 2000);
    const elapsed = Date.now() - start;
    expect(evt.type).toBe("completed");
    // With a 25ms poll interval the event must arrive in well under
    // 400ms (generous slack for loaded CI boxes).
    expect(elapsed).toBeLessThan(400);
  });
});
