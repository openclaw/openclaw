import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-run-node-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createExitedProcess(code: number | null, signal: string | null = null) {
  return {
    on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
      if (event === "exit") {
        queueMicrotask(() => cb(code, signal));
      }
      return undefined;
    },
  };
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const argsPath = path.join(tmp, ".pnpm-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === "pnpm") {
            fsSync.writeFileSync(argsPath, args.join(" "), "utf-8");
            if (!args.includes("--no-clean")) {
              fsSync.rmSync(path.join(tmp, "dist", "control-ui"), { recursive: true, force: true });
            }
          }
          if (cmd === process.execPath) {
            nodeCalls.push([cmd, ...args]);
          }
          return {
            on: (event: string, cb: (code: number | null, signal: string | null) => void) => {
              if (event === "exit") {
                queueMicrotask(() => cb(0, null));
              }
              return undefined;
            },
          };
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["--version"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain("exec tsdown --no-clean");
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([[process.execPath, "openclaw.mjs", "--version"]]);
      });
    },
  );

  it("skips rebuilding when dist is current and the source tree is clean", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const oldTime = new Date("2026-03-13T10:00:00.000Z");
      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      await fs.utimes(srcPath, oldTime, oldTime);
      await fs.utimes(tsconfigPath, oldTime, oldTime);
      await fs.utimes(packageJsonPath, oldTime, oldTime);
      await fs.utimes(distEntryPath, stampTime, stampTime);
      await fs.utimes(buildStampPath, stampTime, stampTime);

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const spawnSync = (cmd: string, args: string[]) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          return { status: 0, stdout: "abc123\n" };
        }
        if (cmd === "git" && args[0] === "status") {
          return { status: 0, stdout: "" };
        }
        return { status: 1, stdout: "" };
      };

      const { runNodeMain } = await import("../../scripts/run-node.mjs");
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        spawnSync,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", "status"]]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "returns the build exit code when the compiler step fails",
    async () => {
      await withTempDir(async (tmp) => {
        const spawn = (cmd: string) => {
          if (cmd === "pnpm") {
            return createExitedProcess(23);
          }
          return createExitedProcess(0);
        };

        const { runNodeMain } = await import("../../scripts/run-node.mjs");
        const exitCode = await runNodeMain({
          cwd: tmp,
          args: ["status"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });

        expect(exitCode).toBe(23);
      });
    },
  );
});
