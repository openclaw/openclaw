// Real-process regression for strict process-group termination confirmation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("strict process-tree termination", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt(
    "kills a SIGTERM-resistant descendant in the supervised process group",
    async () => {
      const program = String.raw`
      import { spawn } from "node:child_process";
      import { forceKillProcessTreeAndWait } from "./src/process/supervisor/process-tree-termination.ts";
      const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const readFirstLine = (child) => new Promise((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(() => reject(new Error("fixture startup timeout")), 5000);
        child.once("error", reject);
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timeout);
          resolve(stdout.slice(0, newline));
        });
      });
      const descendantProgram = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
      const rootProgram = [
        'const {spawn}=require("node:child_process")',
        'const child=spawn(process.execPath,["-e",' + JSON.stringify(descendantProgram) + '],{stdio:"ignore"})',
        'process.stdout.write(String(child.pid)+"\\n")',
        'process.on("SIGTERM",()=>process.exit(0))',
        'setInterval(()=>{},1000)',
      ].join(";");
      const root = spawn(process.execPath, ["-e", rootProgram], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      const rootPid = root.pid;
      try {
        if (!rootPid) throw new Error("fixture root pid unavailable");
        const descendantPid = Number.parseInt(await readFirstLine(root), 10);
        const confirmed = await forceKillProcessTreeAndWait({ pid: rootPid, detached: true, timeoutMs: 5000 });
        process.stdout.write(JSON.stringify({ confirmed, groupAlive: isAlive(-rootPid), descendantAlive: isAlive(descendantPid) }));
      } finally {
        if (rootPid) { try { process.kill(-rootPid, "SIGKILL"); } catch {} }
      }
    `;

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: process.cwd(),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );

      expect(JSON.parse(stdout)).toEqual({
        confirmed: true,
        groupAlive: false,
        descendantAlive: false,
      });
    },
    20_000,
  );

  posixIt(
    "retains scope ownership after the root exits before drain begins",
    async () => {
      const program = String.raw`
      import { createProcessSupervisor } from "./src/process/supervisor/supervisor.ts";
      import { spawnSync } from "node:child_process";
      const isAlive = (pid) => {
        const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
        const stat = probe.stdout.trim();
        return probe.status === 0 && stat.length > 0 && !stat.startsWith("Z");
      };
      const descendantProgram = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
      const rootProgram = [
        'const {spawn}=require("node:child_process")',
        'const child=spawn(process.execPath,["-e",' + JSON.stringify(descendantProgram) + '],{stdio:"ignore"})',
        'process.stdout.write(String(child.pid)+"\\n")',
        'setTimeout(()=>process.exit(0),150)',
      ].join(";");
      const supervisor = createProcessSupervisor();
      let descendantPid;
      try {
        const run = await supervisor.spawn({
          mode: "child",
          scopeKey: "scope:root-first-real",
          sessionId: "root-first-real",
          backendId: "test",
          argv: [process.execPath, "-e", rootProgram],
          stdinMode: "pipe-closed",
        });
        const exit = await run.wait();
        descendantPid = Number.parseInt(exit.stdout.trim(), 10);
        if (!Number.isFinite(descendantPid) || !isAlive(descendantPid)) {
          throw new Error("escaped descendant was not alive after root exit");
        }
        await supervisor.cancelScopeAndWait("scope:root-first-real", { timeoutMs: 5000 });
        process.stdout.write(JSON.stringify({ descendantAlive: isAlive(descendantPid) }));
      } finally {
        if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
      }
    `;

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: process.cwd(),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );

      expect(JSON.parse(stdout)).toEqual({ descendantAlive: false });
    },
    20_000,
  );

  posixIt(
    "drains an immediate root exit while its process group remains alive",
    async () => {
      const program = String.raw`
      import { createProcessSupervisor } from "./src/process/supervisor/supervisor.ts";
      import { spawnSync } from "node:child_process";
      const isAlive = (pid) => {
        const probe = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
        const stat = probe.stdout.trim();
        return probe.status === 0 && stat.length > 0 && !stat.startsWith("Z");
      };
      const descendantProgram = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
      const rootProgram = [
        'const {spawn}=require("node:child_process")',
        'const child=spawn(process.execPath,["-e",' + JSON.stringify(descendantProgram) + '],{stdio:"ignore"})',
        'process.stdout.write(String(child.pid)+"\\n")',
        'process.exit(0)',
      ].join(";");
      const supervisor = createProcessSupervisor();
      let descendantPid;
      try {
        const run = await supervisor.spawn({
          mode: "child",
          scopeKey: "scope:fast-daemon",
          sessionId: "fast-daemon",
          backendId: "test",
          argv: [process.execPath, "-e", rootProgram],
          stdinMode: "pipe-closed",
        });
        const exit = await run.wait();
        descendantPid = Number.parseInt(exit.stdout.trim(), 10);
        await supervisor.cancelScopeAndWait("scope:fast-daemon", { timeoutMs: 1000 });
        const drained = true;
        process.stdout.write(JSON.stringify({ drained, descendantAlive: isAlive(descendantPid) }));
      } finally {
        if (descendantPid) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
      }
    `;

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: process.cwd(),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );

      expect(JSON.parse(stdout)).toEqual({ drained: true, descendantAlive: false });
    },
    20_000,
  );

  posixIt(
    "releases a completed short command without poisoning its scope",
    async () => {
      const program = String.raw`
      import { createProcessSupervisor } from "./src/process/supervisor/supervisor.ts";
      const supervisor = createProcessSupervisor();
      const run = await supervisor.spawn({
        mode: "child",
        scopeKey: "scope:short-command",
        sessionId: "short-command",
        backendId: "test",
        argv: [process.execPath, "-e", "process.exit(0)"],
        stdinMode: "pipe-closed",
      });
      await run.wait();
      await supervisor.cancelScopeAndWait("scope:short-command", { timeoutMs: 1000 });
      process.stdout.write("drained");
    `;

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", program],
        {
          cwd: process.cwd(),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );

      expect(stdout).toBe("drained");
    },
    20_000,
  );
});
