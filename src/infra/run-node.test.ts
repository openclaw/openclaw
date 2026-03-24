import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runNodeMain } from "../../scripts/run-node.mjs";

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

async function writeRuntimePostBuildScaffold(tmp: string): Promise<void> {
  const pluginSdkAliasPath = path.join(tmp, "src", "plugin-sdk", "root-alias.cjs");
  await fs.mkdir(path.dirname(pluginSdkAliasPath), { recursive: true });
  await fs.mkdir(path.join(tmp, "extensions"), { recursive: true });
  await fs.writeFile(pluginSdkAliasPath, "module.exports = {};\n", "utf-8");
  const baselineTime = new Date("2026-03-13T09:00:00.000Z");
  await fs.utimes(pluginSdkAliasPath, baselineTime, baselineTime);
}

function expectedBuildScriptPath(packageRoot: string) {
  return path.join(packageRoot, "scripts", "tsdown-build.mjs");
}

function expectedBuildSpawn(packageRoot: string, execArgv: string[] = process.execArgv) {
  return [process.execPath, ...execArgv, expectedBuildScriptPath(packageRoot), "--no-clean"];
}

function expectedOpenClawSpawn(
  packageRoot: string,
  args: string[],
  execArgv: string[] = process.execArgv,
) {
  return [process.execPath, ...execArgv, path.join(packageRoot, "openclaw.mjs"), ...args];
}

describe("run-node script", () => {
  it.runIf(process.platform !== "win32")(
    "preserves control-ui assets by building with tsdown --no-clean",
    async () => {
      await withTempDir(async (tmp) => {
        const argsPath = path.join(tmp, ".build-args.txt");
        const indexPath = path.join(tmp, "dist", "control-ui", "index.html");

        await writeRuntimePostBuildScaffold(tmp);
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, "<html>sentinel</html>\n", "utf-8");

        const nodeCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          if (cmd === process.execPath && args.includes(expectedBuildScriptPath(tmp))) {
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
        await expect(fs.readFile(argsPath, "utf-8")).resolves.toContain(
          `${expectedBuildScriptPath(tmp)} --no-clean`,
        );
        await expect(fs.readFile(indexPath, "utf-8")).resolves.toContain("sentinel");
        expect(nodeCalls).toEqual([
          expectedBuildSpawn(tmp),
          expectedOpenClawSpawn(tmp, ["--version"]),
        ]);
      });
    },
  );

  it("copies bundled plugin metadata after rebuilding from a clean dist", async () => {
    await withTempDir(async (tmp) => {
      const extensionManifestPath = path.join(tmp, "extensions", "demo", "openclaw.plugin.json");
      const extensionPackagePath = path.join(tmp, "extensions", "demo", "package.json");

      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(extensionManifestPath), { recursive: true });
      await fs.writeFile(
        extensionManifestPath,
        '{"id":"demo","configSchema":{"type":"object"}}\n',
        "utf-8",
      );
      await fs.writeFile(
        extensionPackagePath,
        JSON.stringify(
          {
            name: "demo",
            openclaw: {
              extensions: ["./src/index.ts", "./nested/entry.mts"],
            },
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };

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

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([expectedBuildSpawn(tmp), expectedOpenClawSpawn(tmp, ["status"])]);

      await expect(
        fs.readFile(path.join(tmp, "dist", "plugin-sdk", "root-alias.cjs"), "utf-8"),
      ).resolves.toContain("module.exports = {};");
      await expect(
        fs
          .readFile(path.join(tmp, "dist", "extensions", "demo", "openclaw.plugin.json"), "utf-8")
          .then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({ id: "demo" });
      await expect(
        fs.readFile(path.join(tmp, "dist", "extensions", "demo", "package.json"), "utf-8"),
      ).resolves.toContain(
        '"extensions": [\n      "./src/index.js",\n      "./nested/entry.js"\n    ]',
      );
    });
  });

  it("preserves runtime cwd overrides while building from the package root", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        cwd: string | undefined;
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          cwd: spawnOptions?.cwd,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUNNER_RUNTIME_CWD: "/tmp/openclaw-runtime",
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]).toMatchObject({
        cmd: process.execPath,
        args: expectedBuildSpawn(tmp).slice(1),
        cwd: "/tmp/openclaw-runtime",
        env: expect.objectContaining({
          OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT: tmp,
        }),
      });
      expect(spawnCalls[1]).toMatchObject({
        cmd: process.execPath,
        args: [...process.execArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
        cwd: "/tmp/openclaw-runtime",
      });
      expect(spawnCalls[1]?.env?.OPENCLAW_RUNNER_RUNTIME_CWD).toBeUndefined();
    });
  });

  it("builds from the wrapper package root even when runtime cwd is external", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);
      const runtimeCwd = path.join(tmp, "runtime");
      await fs.mkdir(runtimeCwd, { recursive: true });

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        cwd: string | undefined;
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          cwd: spawnOptions?.cwd,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const exitCode = await runNodeMain({
        cwd: runtimeCwd,
        scriptPath: path.join(tmp, "scripts", "run-node.mjs"),
        args: ["gateway"],
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
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: expectedBuildSpawn(tmp).slice(1),
          cwd: runtimeCwd,
          env: expect.objectContaining({
            OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT: tmp,
          }),
        },
        {
          cmd: process.execPath,
          args: [...process.execArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
          cwd: runtimeCwd,
          env: expect.anything(),
        },
      ]);
    });
  });

  it("forwards execArgv to the final openclaw process", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };

      const exitCode = await runNodeMain({
        cwd: tmp,
        execArgv: ["--max-old-space-size=4096", "--trace-warnings"],
        args: ["gateway"],
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
      expect(spawnCalls).toEqual([
        expectedBuildSpawn(tmp, ["--max-old-space-size=4096", "--trace-warnings"]),
        expectedOpenClawSpawn(tmp, ["gateway"], ["--max-old-space-size=4096", "--trace-warnings"]),
      ]);
    });
  });

  it("prefers forwarded execArgv from env while stripping inspector flags from the rebuild child", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const forwardedExecArgv = ["--inspect=9229", "--trace-warnings"];
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: JSON.stringify(forwardedExecArgv),
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: ["--trace-warnings", expectedBuildScriptPath(tmp), "--no-clean"],
          env: expect.not.objectContaining({
            OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: expect.any(String),
          }),
        },
        {
          cmd: process.execPath,
          args: [...forwardedExecArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
          env: expect.not.objectContaining({
            OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: expect.any(String),
          }),
        },
      ]);
    });
  });

  it("strips watch flags from the rebuild child while preserving them for the final openclaw process", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
      }> = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push({
          cmd,
          args,
        });
        return createExitedProcess(0);
      };

      const execArgv = [
        "--watch",
        "--watch-path",
        "src",
        "--watch-preserve-output",
        "--trace-warnings",
      ];
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        execArgv,
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: ["--trace-warnings", expectedBuildScriptPath(tmp), "--no-clean"],
        },
        {
          cmd: process.execPath,
          args: [...execArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
        },
      ]);
    });
  });

  it("strips inspector flags from the rebuild child while preserving them for the final openclaw process", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
      }> = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push({
          cmd,
          args,
        });
        return createExitedProcess(0);
      };

      const execArgv = [
        "--inspect=9229",
        "--inspect-port",
        "9230",
        "--trace-warnings",
        "--inspect-wait",
        "--inspect-brk",
      ];
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        execArgv,
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        execPath: process.execPath,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: ["--trace-warnings", expectedBuildScriptPath(tmp), "--no-clean"],
        },
        {
          cmd: process.execPath,
          args: [...execArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
        },
      ]);
    });
  });

  it("preserves forwarded preload flags for the final openclaw process", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const forwardedExecArgv = ["--import", "./loader.mjs", "--trace-warnings"];
      const originalExecArgv = [...process.execArgv];
      process.execArgv = ["--trace-warnings"];
      let exitCode: number;
      try {
        exitCode = await runNodeMain({
          cwd: tmp,
          args: ["gateway"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
            OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: JSON.stringify(forwardedExecArgv),
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });
      } finally {
        process.execArgv = originalExecArgv;
      }

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: [...forwardedExecArgv, expectedBuildScriptPath(tmp), "--no-clean"],
          env: expect.not.objectContaining({
            OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: expect.any(String),
          }),
        },
        {
          cmd: process.execPath,
          args: [...forwardedExecArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
          env: expect.not.objectContaining({
            OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: expect.any(String),
          }),
        },
      ]);
    });
  });

  it("restores forwarded NODE_OPTIONS while stripping inspector flags from the rebuild child", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const forwardedNodeOptions =
        '--inspect=9229 --require "./loader.js" --max-old-space-size=4096';
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        execArgv: [],
        env: {
          ...process.env,
          NODE_OPTIONS: "--max-old-space-size=4096",
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS: forwardedNodeOptions,
        },
        spawn,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: [expectedBuildScriptPath(tmp), "--no-clean"],
          env: expect.objectContaining({
            NODE_OPTIONS: '--require "./loader.js" --max-old-space-size=4096',
            OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT: tmp,
          }),
        },
        {
          cmd: process.execPath,
          args: [path.join(tmp, "openclaw.mjs"), "gateway"],
          env: expect.objectContaining({
            NODE_OPTIONS: forwardedNodeOptions,
          }),
        },
      ]);
      expect(spawnCalls[0]?.env).not.toEqual(
        expect.objectContaining({
          OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS: expect.any(String),
        }),
      );
      expect(spawnCalls[1]?.env).not.toEqual(
        expect.objectContaining({
          OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS: expect.any(String),
        }),
      );
    });
  });

  it("strips watch NODE_OPTIONS from the rebuild child while preserving them for the final openclaw process", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const forwardedNodeOptions =
        "--watch --watch-path=src --watch-preserve-output --max-old-space-size=4096";
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        execArgv: [],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS: forwardedNodeOptions,
        },
        spawn,
        execPath: process.execPath,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: [expectedBuildScriptPath(tmp), "--no-clean"],
          env: expect.objectContaining({
            NODE_OPTIONS: "--max-old-space-size=4096",
            OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT: tmp,
          }),
        },
        {
          cmd: process.execPath,
          args: [path.join(tmp, "openclaw.mjs"), "gateway"],
          env: expect.objectContaining({
            NODE_OPTIONS: forwardedNodeOptions,
          }),
        },
      ]);
    });
  });

  it("strips inspector NODE_OPTIONS from the rebuild child while preserving them for the final openclaw process", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const forwardedNodeOptions =
        "--inspect=9229 --inspect-port 9230 --inspect-publish-uid stderr --inspect-wait --inspect-brk --max-old-space-size=4096";
      const exitCode = await runNodeMain({
        cwd: tmp,
        args: ["gateway"],
        execArgv: [],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
          OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS: forwardedNodeOptions,
        },
        spawn,
        execPath: process.execPath,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: [expectedBuildScriptPath(tmp), "--no-clean"],
          env: expect.objectContaining({
            NODE_OPTIONS: "--max-old-space-size=4096",
            OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT: tmp,
          }),
        },
        {
          cmd: process.execPath,
          args: [path.join(tmp, "openclaw.mjs"), "gateway"],
          env: expect.objectContaining({
            NODE_OPTIONS: forwardedNodeOptions,
          }),
        },
      ]);
    });
  });

  it("keeps rebuild preloads on the runtime cwd while building from the package root", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);
      const runtimeCwd = path.join(tmp, "runtime");
      await fs.mkdir(runtimeCwd, { recursive: true });

      const spawnCalls: Array<{
        cmd: string;
        args: string[];
        cwd: string | undefined;
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const spawn = (cmd: string, args: string[], options: unknown) => {
        const spawnOptions = options as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
        spawnCalls.push({
          cmd,
          args,
          cwd: spawnOptions?.cwd,
          env: spawnOptions?.env,
        });
        return createExitedProcess(0);
      };

      const forwardedExecArgv = ["--require", "./loader.cjs"];
      const forwardedNodeOptions = '--import "./loader.mjs"';
      const originalExecArgv = [...process.execArgv];
      process.execArgv = [];
      let exitCode: number;
      try {
        exitCode = await runNodeMain({
          cwd: runtimeCwd,
          scriptPath: path.join(tmp, "scripts", "run-node.mjs"),
          args: ["gateway"],
          env: {
            ...process.env,
            OPENCLAW_FORCE_BUILD: "1",
            OPENCLAW_RUNNER_LOG: "0",
            OPENCLAW_RUNNER_FORWARDED_EXEC_ARGV: JSON.stringify(forwardedExecArgv),
            OPENCLAW_RUNNER_FORWARDED_NODE_OPTIONS: forwardedNodeOptions,
          },
          spawn,
          execPath: process.execPath,
          platform: process.platform,
        });
      } finally {
        process.execArgv = originalExecArgv;
      }

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([
        {
          cmd: process.execPath,
          args: [...forwardedExecArgv, expectedBuildScriptPath(tmp), "--no-clean"],
          cwd: runtimeCwd,
          env: expect.objectContaining({
            NODE_OPTIONS: forwardedNodeOptions,
            OPENCLAW_RUNNER_BUILD_PACKAGE_ROOT: tmp,
          }),
        },
        {
          cmd: process.execPath,
          args: [...forwardedExecArgv, path.join(tmp, "openclaw.mjs"), "gateway"],
          cwd: runtimeCwd,
          env: expect.objectContaining({
            NODE_OPTIONS: forwardedNodeOptions,
          }),
        },
      ]);
    });
  });

  it("checks git head from the wrapper package root when runtime cwd is external", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);
      const runtimeCwd = path.join(tmp, "runtime");
      const srcPath = path.join(tmp, "src", "index.ts");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      await fs.mkdir(runtimeCwd, { recursive: true });
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      await fs.utimes(srcPath, stampTime, stampTime);
      await fs.utimes(tsconfigPath, stampTime, stampTime);
      await fs.utimes(packageJsonPath, stampTime, stampTime);
      await fs.utimes(distEntryPath, stampTime, stampTime);
      await fs.utimes(buildStampPath, stampTime, stampTime);

      const spawnCalls: string[][] = [];
      const gitCwds: string[] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const spawnSync = (cmd: string, args: string[], options?: { cwd?: string }) => {
        if (cmd === "git") {
          gitCwds.push(options?.cwd ?? "");
        }
        if (cmd === "git" && args[0] === "rev-parse") {
          return { status: 0, stdout: "abc123\n" };
        }
        if (cmd === "git" && args[0] === "status") {
          return { status: 0, stdout: "" };
        }
        return { status: 1, stdout: "" };
      };

      const exitCode = await runNodeMain({
        cwd: runtimeCwd,
        scriptPath: path.join(tmp, "scripts", "run-node.mjs"),
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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
      expect(gitCwds).toEqual([tmp, tmp]);
    });
  });

  it("writes build stamps under the wrapper package root when runtime cwd is external", async () => {
    await withTempDir(async (tmp) => {
      await writeRuntimePostBuildScaffold(tmp);
      const runtimeCwd = path.join(tmp, "runtime");
      await fs.mkdir(runtimeCwd, { recursive: true });

      const spawn = () => createExitedProcess(0);
      const spawnSync = (cmd: string, args: string[]) => {
        if (cmd === "git" && args[0] === "rev-parse") {
          return { status: 0, stdout: "abc123\n" };
        }
        return { status: 1, stdout: "" };
      };

      const exitCode = await runNodeMain({
        cwd: runtimeCwd,
        scriptPath: path.join(tmp, "scripts", "run-node.mjs"),
        args: ["status"],
        env: {
          ...process.env,
          OPENCLAW_FORCE_BUILD: "1",
          OPENCLAW_RUNNER_LOG: "0",
        },
        spawn,
        spawnSync,
        execPath: process.execPath,
        platform: process.platform,
      });

      expect(exitCode).toBe(0);
      await expect(fs.readFile(path.join(tmp, "dist", ".buildstamp"), "utf-8")).resolves.toContain(
        '"head":"abc123"',
      );
      await expect(fs.access(path.join(runtimeCwd, "dist", ".buildstamp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("skips rebuilding when dist is current and the source tree is clean", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      await writeRuntimePostBuildScaffold(tmp);
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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
    });
  });

  it("returns the build exit code when the compiler step fails", async () => {
    await withTempDir(async (tmp) => {
      const spawn = (cmd: string, args: string[] = []) => {
        if (cmd === process.execPath && args.includes(expectedBuildScriptPath(tmp))) {
          return createExitedProcess(23);
        }
        return createExitedProcess(0);
      };

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
  });

  it("rebuilds when extension sources are newer than the build stamp", async () => {
    await withTempDir(async (tmp) => {
      const extensionPath = path.join(tmp, "extensions", "demo", "src", "index.ts");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(extensionPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(extensionPath, "export const extensionValue = 1;\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      const newTime = new Date("2026-03-13T12:00:01.000Z");
      await fs.utimes(tsconfigPath, stampTime, stampTime);
      await fs.utimes(packageJsonPath, stampTime, stampTime);
      await fs.utimes(distEntryPath, stampTime, stampTime);
      await fs.utimes(buildStampPath, stampTime, stampTime);
      await fs.utimes(extensionPath, newTime, newTime);

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const spawnSync = () => ({ status: 1, stdout: "" });

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
      expect(spawnCalls).toEqual([expectedBuildSpawn(tmp), expectedOpenClawSpawn(tmp, ["status"])]);
    });
  });

  it("skips rebuilding when extension package metadata is newer than the build stamp", async () => {
    await withTempDir(async (tmp) => {
      const manifestPath = path.join(tmp, "extensions", "demo", "openclaw.plugin.json");
      const packagePath = path.join(tmp, "extensions", "demo", "package.json");
      const distPackagePath = path.join(tmp, "dist", "extensions", "demo", "package.json");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.mkdir(path.dirname(packagePath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.mkdir(path.dirname(distPackagePath), { recursive: true });
      await fs.writeFile(manifestPath, '{"id":"demo","configSchema":{"type":"object"}}\n', "utf-8");
      await fs.writeFile(
        packagePath,
        '{"name":"demo","openclaw":{"extensions":["./index.ts"]}}\n',
        "utf-8",
      );
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(
        distPackagePath,
        '{"name":"demo","openclaw":{"extensions":["./stale.js"]}}\n',
        "utf-8",
      );
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const oldTime = new Date("2026-03-13T10:00:00.000Z");
      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      const newTime = new Date("2026-03-13T12:00:01.000Z");
      await fs.utimes(manifestPath, oldTime, oldTime);
      await fs.utimes(tsconfigPath, oldTime, oldTime);
      await fs.utimes(packageJsonPath, oldTime, oldTime);
      await fs.utimes(tsdownConfigPath, oldTime, oldTime);
      await fs.utimes(distEntryPath, stampTime, stampTime);
      await fs.utimes(buildStampPath, stampTime, stampTime);
      await fs.utimes(packagePath, newTime, newTime);

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const spawnSync = () => ({ status: 1, stdout: "" });

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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
      await expect(fs.readFile(distPackagePath, "utf-8")).resolves.toContain('"./index.js"');
    });
  });

  it("skips rebuilding for dirty non-source files under extensions", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const readmePath = path.join(tmp, "extensions", "demo", "README.md");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(readmePath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(readmePath, "# demo\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      await fs.utimes(srcPath, stampTime, stampTime);
      await fs.utimes(readmePath, stampTime, stampTime);
      await fs.utimes(tsconfigPath, stampTime, stampTime);
      await fs.utimes(packageJsonPath, stampTime, stampTime);
      await fs.utimes(tsdownConfigPath, stampTime, stampTime);
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
          return { status: 0, stdout: " M extensions/demo/README.md\n" };
        }
        return { status: 1, stdout: "" };
      };

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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
    });
  });

  it("skips rebuilding for dirty extension manifests that only affect runtime reload", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const manifestPath = path.join(tmp, "extensions", "demo", "openclaw.plugin.json");
      const distManifestPath = path.join(tmp, "dist", "extensions", "demo", "openclaw.plugin.json");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.mkdir(path.dirname(distManifestPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(manifestPath, '{"id":"demo","configSchema":{"type":"object"}}\n', "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(
        distManifestPath,
        '{"id":"stale","configSchema":{"type":"object"}}\n',
        "utf-8",
      );
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      await fs.utimes(srcPath, stampTime, stampTime);
      await fs.utimes(manifestPath, stampTime, stampTime);
      await fs.utimes(tsconfigPath, stampTime, stampTime);
      await fs.utimes(packageJsonPath, stampTime, stampTime);
      await fs.utimes(tsdownConfigPath, stampTime, stampTime);
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
          return { status: 0, stdout: " M extensions/demo/openclaw.plugin.json\n" };
        }
        return { status: 1, stdout: "" };
      };

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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
      await expect(
        fs.readFile(distManifestPath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        id: "demo",
      });
    });
  });

  it("repairs missing bundled plugin metadata without rerunning tsdown", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const manifestPath = path.join(tmp, "extensions", "demo", "openclaw.plugin.json");
      const distManifestPath = path.join(tmp, "dist", "extensions", "demo", "openclaw.plugin.json");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(manifestPath, '{"id":"demo","configSchema":{"type":"object"}}\n', "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      await fs.utimes(srcPath, stampTime, stampTime);
      await fs.utimes(manifestPath, stampTime, stampTime);
      await fs.utimes(tsconfigPath, stampTime, stampTime);
      await fs.utimes(packageJsonPath, stampTime, stampTime);
      await fs.utimes(tsdownConfigPath, stampTime, stampTime);
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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
      await expect(
        fs.readFile(distManifestPath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        id: "demo",
      });
    });
  });

  it("removes stale bundled plugin metadata when the source manifest is gone", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const extensionDir = path.join(tmp, "extensions", "demo");
      const distManifestPath = path.join(tmp, "dist", "extensions", "demo", "openclaw.plugin.json");
      const distPackagePath = path.join(tmp, "dist", "extensions", "demo", "package.json");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(extensionDir, { recursive: true });
      await fs.mkdir(path.dirname(distManifestPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");
      await fs.writeFile(
        distManifestPath,
        '{"id":"stale","configSchema":{"type":"object"}}\n',
        "utf-8",
      );
      await fs.writeFile(distPackagePath, '{"name":"stale"}\n', "utf-8");

      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      await fs.utimes(srcPath, stampTime, stampTime);
      await fs.utimes(tsconfigPath, stampTime, stampTime);
      await fs.utimes(packageJsonPath, stampTime, stampTime);
      await fs.utimes(tsdownConfigPath, stampTime, stampTime);
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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
      await expect(fs.access(distManifestPath)).rejects.toThrow();
      await expect(fs.access(distPackagePath)).rejects.toThrow();
    });
  });

  it("skips rebuilding when only non-source extension files are newer than the build stamp", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const readmePath = path.join(tmp, "extensions", "demo", "README.md");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(readmePath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(readmePath, "# demo\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const oldTime = new Date("2026-03-13T10:00:00.000Z");
      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      const newTime = new Date("2026-03-13T12:00:01.000Z");
      await fs.utimes(srcPath, oldTime, oldTime);
      await fs.utimes(tsconfigPath, oldTime, oldTime);
      await fs.utimes(packageJsonPath, oldTime, oldTime);
      await fs.utimes(tsdownConfigPath, oldTime, oldTime);
      await fs.utimes(distEntryPath, stampTime, stampTime);
      await fs.utimes(buildStampPath, stampTime, stampTime);
      await fs.utimes(readmePath, newTime, newTime);

      const spawnCalls: string[][] = [];
      const spawn = (cmd: string, args: string[]) => {
        spawnCalls.push([cmd, ...args]);
        return createExitedProcess(0);
      };
      const spawnSync = () => ({ status: 1, stdout: "" });

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
      expect(spawnCalls).toEqual([expectedOpenClawSpawn(tmp, ["status"])]);
    });
  });

  it("rebuilds when tsdown config is newer than the build stamp", async () => {
    await withTempDir(async (tmp) => {
      const srcPath = path.join(tmp, "src", "index.ts");
      const distEntryPath = path.join(tmp, "dist", "entry.js");
      const buildStampPath = path.join(tmp, "dist", ".buildstamp");
      const tsconfigPath = path.join(tmp, "tsconfig.json");
      const packageJsonPath = path.join(tmp, "package.json");
      const tsdownConfigPath = path.join(tmp, "tsdown.config.ts");
      await writeRuntimePostBuildScaffold(tmp);
      await fs.mkdir(path.dirname(srcPath), { recursive: true });
      await fs.mkdir(path.dirname(distEntryPath), { recursive: true });
      await fs.writeFile(srcPath, "export const value = 1;\n", "utf-8");
      await fs.writeFile(tsconfigPath, "{}\n", "utf-8");
      await fs.writeFile(packageJsonPath, '{"name":"openclaw-test"}\n', "utf-8");
      await fs.writeFile(tsdownConfigPath, "export default {};\n", "utf-8");
      await fs.writeFile(distEntryPath, "console.log('built');\n", "utf-8");
      await fs.writeFile(buildStampPath, '{"head":"abc123"}\n', "utf-8");

      const oldTime = new Date("2026-03-13T10:00:00.000Z");
      const stampTime = new Date("2026-03-13T12:00:00.000Z");
      const newTime = new Date("2026-03-13T12:00:01.000Z");
      await fs.utimes(srcPath, oldTime, oldTime);
      await fs.utimes(tsconfigPath, oldTime, oldTime);
      await fs.utimes(packageJsonPath, oldTime, oldTime);
      await fs.utimes(distEntryPath, stampTime, stampTime);
      await fs.utimes(buildStampPath, stampTime, stampTime);
      await fs.utimes(tsdownConfigPath, newTime, newTime);

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
      expect(spawnCalls).toEqual([expectedBuildSpawn(tmp), expectedOpenClawSpawn(tmp, ["status"])]);
    });
  });
});
