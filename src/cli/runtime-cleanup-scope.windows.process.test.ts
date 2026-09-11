import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";

const fixture = fileURLToPath(
  new URL("./runtime-cleanup-scope.windows.test-support.ts", import.meta.url),
);

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.runIf(process.platform === "win32")("Windows executable process ownership", () => {
  it.each([
    { ownership: "cli", inherited: false, exitCode: 0, descendants: true },
    { ownership: "cli", inherited: false, exitCode: 0, descendants: false },
    { ownership: "cli", inherited: true, exitCode: 0, descendants: true },
    { ownership: "cli", inherited: true, exitCode: 1, descendants: true },
    { ownership: "borrowed", inherited: false, exitCode: 0, descendants: true },
    { ownership: "borrowed", inherited: false, exitCode: 0, descendants: false },
    { ownership: "gateway", inherited: false, exitCode: 0, descendants: true },
  ])(
    "preserves $ownership exit $exitCode (inherited Job: $inherited, descendants: $descendants)",
    async ({ ownership, inherited, exitCode, descendants }) => {
      const parent = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fixture,
          "harness",
          ownership,
          String(inherited),
          String(exitCode),
          String(descendants),
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
      );
      const closed = once(parent, "close");
      let diagnostics = "";
      parent.stderr?.on("data", (chunk) => (diagnostics += String(chunk)));
      let descendantPid: number | undefined;
      try {
        const [message] = await once(parent, "message", { signal: AbortSignal.timeout(20_000) });
        expect(message, diagnostics).toMatchObject({ code: exitCode, signal: null, stderr: "" });
        const result = JSON.parse(message.stdout);
        descendantPid = result.descendantPid;
        if (descendants) {
          expect(Number.isSafeInteger(descendantPid), message.stdout).toBe(true);
        }
        expect(result).toMatchObject({
          launcherExited: true,
          settlement:
            descendants || ownership !== "cli" ? "CommandProcessScopeUnsettledError" : "settled",
          ...(inherited ? { inheritedJob: true } : {}),
        });
        expect(isPidAlive(parent.pid!)).toBe(true);
        if (descendants && ownership === "cli") {
          expect(await waitForPidToExit(descendantPid!)).toBe(true);
        } else if (descendants) {
          expect(isPidAlive(descendantPid!)).toBe(true);
        }
      } finally {
        killPidIfAlive(descendantPid);
        killPidIfAlive(parent.pid);
        await closed;
      }
    },
    30_000,
  );

  it.each(["busy", "retire", "rearm"] as const)(
    "hands off only the intended fallback after settled ownership (%s)",
    async (mode) => {
      const marker = path.join(dirs.make("windows-job-fallback-"), "gateway.pid");
      const parent = spawn(
        process.execPath,
        ["--import", "tsx", fixture, "handoff-harness", mode, "false", "0", "false", marker],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
      );
      const closed = once(parent, "close");
      let diagnostics = "";
      parent.stderr?.on("data", (chunk) => (diagnostics += String(chunk)));
      let descendantPid: number | undefined;
      let fallbackPid: number | undefined;
      try {
        const [message] = await once(parent, "message", { signal: AbortSignal.timeout(20_000) });
        expect(message, diagnostics).toMatchObject({ code: 0, signal: null, stderr: "" });
        const result = JSON.parse(message.stdout);
        descendantPid = result.descendantPid;
        fallbackPid = result.fallbackPid;
        expect(result.settlement).toBe(
          mode === "retire" ? "settled" : "CommandProcessScopeUnsettledError",
        );
        if (mode === "busy") {
          expect(fallbackPid).toBeUndefined();
        } else {
          expect(Number.isSafeInteger(fallbackPid)).toBe(true);
          expect(isPidAlive(fallbackPid!)).toBe(true);
        }
        if (mode !== "retire") {
          expect(Number.isSafeInteger(descendantPid)).toBe(true);
          expect(await waitForPidToExit(descendantPid!)).toBe(true);
        }
      } finally {
        killPidIfAlive(descendantPid);
        killPidIfAlive(fallbackPid);
        killPidIfAlive(parent.pid);
        await closed;
      }
    },
    30_000,
  );
});
