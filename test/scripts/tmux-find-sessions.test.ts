import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;

it.skipIf(!hasTmux)(
  "lists the session name, attachment state, and start time in the C locale",
  () => {
    const socket = join(temp.make("tmux-"), "socket");
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
    // A parent tmux session would enable UTF-8 regardless of the locale.
    delete env.TMUX;
    const tmux = ["-f", "/dev/null", "-S", socket];
    try {
      execFileSync("tmux", [...tmux, "new-session", "-d", "-s", "build|café", "sleep 15"], { env });
      const output = execFileSync(
        "bash",
        ["skills/tmux/scripts/find-sessions.sh", "-S", socket, "-q", "BUILD|"],
        { encoding: "utf8", env },
      );
      expect(output).toMatch(/^ {2}- build\|café \(detached, started [^)]+\)$/mu);
    } finally {
      spawnSync("tmux", [...tmux, "kill-server"], { env, stdio: "ignore" });
    }
  },
);
