import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDistArtifactLockPath } from "../scripts/lib/dist-artifact-ownership.mts";
import { listTsdownOutputRoots } from "../scripts/tsdown-build.mts";
import { runUpdateGatewayBuild } from "../scripts/update-gateway-build.mts";
import * as gatewayBindings from "../src/daemon/managed-gateway-bindings.js";
import { CommandProcessCleanupError } from "../src/process/exec-result.js";
import { retainCommandProcessCleanup } from "../src/process/exec-spawn.js";
import * as nativeExec from "../src/process/exec.js";

const { buildMock, lifecycleMock } = vi.hoisted(() => ({
  buildMock: vi.fn(),
  lifecycleMock: vi.fn(),
}));
vi.mock("../scripts/build-all.mts", () => ({ runBuildAllSteps: buildMock }));
vi.mock("../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: lifecycleMock,
}));

async function runTransaction(
  stop: string,
  restart: string,
  fixture: {
    root: string;
    build: () => Promise<{ exitCode: number; admissionRefused?: true }>;
    lifecycle: (command: string) => Promise<number>;
  },
) {
  buildMock.mockImplementation(fixture.build);
  lifecycleMock.mockImplementation(({ args }: { args: string[] }) => fixture.lifecycle(args[1]!));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixture.root);
  try {
    return await runUpdateGatewayBuild(stop, restart, shimDir);
  } finally {
    cwd.mockRestore();
  }
}

let scratch: string;
let workdir: string;
let shimDir: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-build-"));
  workdir = path.join(scratch, "checkout");
  shimDir = path.join(scratch, "bin");
  fs.mkdirSync(shimDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("source update build output transaction", () => {
  const outputs = () => listTsdownOutputRoots();
  const writeOutput = (output: string, value: string) => {
    fs.mkdirSync(path.join(workdir, output), { recursive: true });
    fs.writeFileSync(path.join(workdir, output, "marker"), value);
  };
  const readOutput = (output: string) =>
    fs.readFileSync(path.join(workdir, output, "marker"), "utf8");
  const backups = () =>
    fs.readdirSync(workdir).filter((name) => name.startsWith(".update-build-backup."));
  beforeEach(() => fs.mkdirSync(workdir));

  it("refuses publication when a shared consumer starts during candidate import", async () => {
    const command = nativeExec.runCommandWithTimeout;
    const git = async (directory: string, ...args: string[]) => {
      const result = await command(["git", "-C", directory, ...args], {
        cwd: directory,
        timeoutMs: 5_000,
        env: { ...process.env, GIT_CONFIG_COUNT: "0" },
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const writeRuntime = (directory: string, sha: string, marker: string) => {
      fs.mkdirSync(path.join(directory, "dist/control-ui"), { recursive: true });
      fs.writeFileSync(path.join(directory, "dist/entry.js"), "// fixture runtime\n");
      fs.writeFileSync(path.join(directory, "dist/control-ui/index.html"), "ready");
      fs.writeFileSync(
        path.join(directory, "dist/build-info.json"),
        JSON.stringify({ commit: sha, buildId: sha }),
      );
      for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
        fs.writeFileSync(path.join(directory, "dist", name), JSON.stringify({ head: sha }));
      }
      fs.writeFileSync(path.join(directory, "dist/marker"), marker);
    };
    await git(workdir, "init", "--initial-branch=main");
    await git(workdir, "config", "user.name", "OpenClaw Test");
    await git(workdir, "config", "user.email", "openclaw@example.com");
    await git(workdir, "config", "commit.gpgsign", "false");
    fs.writeFileSync(
      path.join(workdir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.4.0" }),
    );
    fs.writeFileSync(path.join(workdir, "pnpm-workspace.yaml"), "packages: []\n");
    fs.writeFileSync(path.join(workdir, ".gitignore"), "dist/\nnode_modules/\n.artifacts/\n");
    await git(workdir, "add", ".");
    await git(workdir, "commit", "-m", "original");
    const before = await git(workdir, "rev-parse", "HEAD");
    await git(workdir, "checkout", "-b", "target");
    fs.writeFileSync(path.join(workdir, "target.txt"), "candidate source\n");
    await git(workdir, "add", "target.txt");
    await git(workdir, "commit", "-m", "target");
    const target = await git(workdir, "rev-parse", "HEAD");
    await git(workdir, "checkout", "main");
    writeRuntime(workdir, before, "original");
    fs.mkdirSync(path.join(workdir, "node_modules"));
    const dependency = path.join(workdir, "node_modules/marker");
    fs.writeFileSync(dependency, "original dependency");
    const originalInodes = ["dist/marker", "node_modules/marker"].map(
      (name) => fs.statSync(path.join(workdir, name)).ino,
    );
    let consumerLive = false;
    let imported = false;
    const observed: boolean[] = [];
    const siblingEnv = { HOME: path.join(scratch, "sibling-home"), OPENCLAW_PROFILE: "sibling" };
    vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([
      { profile: "sibling", env: siblingEnv },
    ]);
    vi.spyOn(gatewayBindings, "readManagedGatewayBindingState").mockImplementation(async () => {
      observed.push(consumerLive);
      return {
        installed: true,
        loadState: { status: "loaded" },
        running: consumerLive,
        env: siblingEnv,
        command: {
          programArguments: [process.execPath, path.join(workdir, "dist/entry.js"), "gateway"],
        },
        runtime: {
          status: consumerLive ? "running" : "stopped",
          pid: consumerLive ? 631 : undefined,
        },
      };
    });
    vi.spyOn(nativeExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv[0] === "pnpm") {
        const directory = typeof options === "number" ? undefined : options.cwd;
        expect(directory).toBeDefined();
        expect(directory).not.toBe(workdir);
        if (argv.includes("install")) {
          fs.mkdirSync(path.join(directory!, "node_modules"), { recursive: true });
          fs.writeFileSync(path.join(directory!, "node_modules/marker"), "candidate dependency");
        }
        if (argv.includes("build")) {
          writeRuntime(directory!, await git(directory!, "rev-parse", "HEAD"), "candidate");
        }
        return {
          code: 0,
          stdout: argv.includes("--version") ? "12.4.0" : "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
          noOutputTimedOut: false,
        };
      }
      const result = await command(argv, options);
      if (argv.includes("index-pack")) {
        expect(result.code, result.stderr).toBe(0);
        imported = true;
        consumerLive = true;
      }
      return result;
    });
    const lifecycle: string[] = [];
    lifecycleMock.mockImplementation(async ({ args }: { args: string[] }) => {
      lifecycle.push(args[1]!);
      if (args[1] === "restart-selected") {
        expect(await git(workdir, "rev-parse", "HEAD")).toBe(before);
        expect(readOutput("dist")).toBe("original");
        expect(fs.readFileSync(dependency, "utf8")).toBe("original dependency");
      }
      return 0;
    });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workdir);
    let outcome: PromiseSettledResult<number>;
    try {
      [outcome] = await Promise.allSettled([
        runUpdateGatewayBuild("stop-selected", "restart-selected", shimDir, target),
      ]);
    } finally {
      cwd.mockRestore();
    }
    expect(imported).toBe(true);
    expect(consumerLive).toBe(true);
    expect(lifecycle).toEqual(["stop-selected", "restart-selected"]);
    expect({
      outcome: outcome.status,
      rejection: outcome.status === "rejected" ? String(outcome.reason) : undefined,
      lastObservedConsumerLive: observed.at(-1),
      head: await git(workdir, "rev-parse", "HEAD"),
      targetSourceExists: fs.existsSync(path.join(workdir, "target.txt")),
      runtime: readOutput("dist"),
      dependency: fs.readFileSync(dependency, "utf8"),
      inodes: ["dist/marker", "node_modules/marker"].map(
        (name) => fs.statSync(path.join(workdir, name)).ino,
      ),
    }).toEqual({
      outcome: "rejected",
      rejection: expect.stringContaining("another managed Gateway"),
      lastObservedConsumerLive: true,
      head: before,
      targetSourceExists: false,
      runtime: "original",
      dependency: "original dependency",
      inodes: originalInodes,
    });
    expect(
      fs
        .readdirSync(path.join(workdir, ".git/objects/pack"))
        .filter((name) => name.endsWith(".keep")),
    ).toEqual([]);
  });

  it.each(["throw", "late", "joined"] as const)(
    "retains reference-update custody only for canonical uncertainty (%s)",
    async (mode) => {
      const uncertain = mode !== "joined";
      const failure = uncertain ? new CommandProcessCleanupError() : new Error("joined refusal");
      const command = vi.spyOn(nativeExec, "runCommandWithTimeout").mockRejectedValue(failure);
      if (mode === "late") {
        command.mockImplementationOnce(async () => {
          retainCommandProcessCleanup(Promise.resolve("uncertain"));
          return {
            stdout: "a".repeat(40),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
            noOutputTimedOut: false,
          };
        });
      }
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(workdir);
      lifecycleMock.mockClear();
      try {
        await expect(
          runUpdateGatewayBuild("stop", "restart", shimDir, "a".repeat(40)),
        ).rejects.toThrow();
        const owner = resolveDistArtifactLockPath(workdir);
        expect(fs.existsSync(path.join(owner, "owner.json"))).toBe(uncertain);
        expect(fs.existsSync(path.join(owner, "unjoined"))).toBe(uncertain);
        expect(command).toHaveBeenCalledTimes(1);
        expect(lifecycleMock).not.toHaveBeenCalled();
      } finally {
        command.mockRestore();
        cwd.mockRestore();
      }
    },
  );

  it("restores every prior owned output, removes newly created output, and restarts only after restoration", async () => {
    const oldRoots = outputs().slice(0, -1);
    for (const output of oldRoots) {
      writeOutput(output, `old:${output}`);
    }
    const events: string[] = [];
    const code = await runTransaction("stop", "restart", {
      root: workdir,
      lifecycle: async (command) => {
        expect(fs.existsSync(path.join(resolveDistArtifactLockPath(workdir), "owner.json"))).toBe(
          true,
        );
        events.push(command);
        if (command === "restart") {
          for (const output of oldRoots) {
            expect(readOutput(output)).toBe(`old:${output}`);
          }
          expect(fs.existsSync(path.join(workdir, outputs().at(-1)!))).toBe(false);
        }
        return 0;
      },
      build: async () => {
        events.push("build");
        for (const output of outputs()) {
          fs.rmSync(path.join(workdir, output), { recursive: true, force: true });
          writeOutput(output, "partial");
        }
        return { exitCode: 17 };
      },
    });
    expect(code).toBe(17);
    expect(events).toEqual(["stop", "build", "restart"]);
    expect(backups()).toEqual([]);
  });

  it("restores output and reports a non-Error build rejection as an Error", async () => {
    writeOutput("dist", "old");
    const events: string[] = [];
    await expect(
      runTransaction("stop", "restart", {
        root: workdir,
        lifecycle: async (command) => {
          events.push(command);
          return 0;
        },
        build: async () => {
          writeOutput("dist", "partial");
          return vi
            .fn<() => Promise<{ exitCode: number }>>()
            .mockRejectedValue("compiler failed")();
        },
      }),
    ).rejects.toMatchObject({ message: "Build failed", cause: "compiler failed" });
    expect(events).toEqual(["stop", "restart"]);
    expect(readOutput("dist")).toBe("old");
    expect(backups()).toEqual([]);
  });

  it("leaves preserved output available to the normal build on success", async () => {
    writeOutput("dist/control-ui", "preserved UI");
    writeOutput("dist", "old");
    const code = await runTransaction("stop", "restart", {
      root: workdir,
      lifecycle: async () => 0,
      build: async () => {
        expect(readOutput("dist/control-ui")).toBe("preserved UI");
        writeOutput("dist", "new");
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(0);
    expect(readOutput("dist")).toBe("new");
    expect(readOutput("dist/control-ui")).toBe("preserved UI");
    expect(backups()).toEqual([]);
  });

  it("does not build or replace outputs after a failed stop", async () => {
    writeOutput("dist", "old");
    let built = false;
    const code = await runTransaction("stop", "restart", {
      root: workdir,
      lifecycle: async () => 23,
      build: async () => {
        built = true;
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(23);
    expect(built).toBe(false);
    expect(readOutput("dist")).toBe("old");
    expect(backups()).toEqual([]);
  });

  it("retains recovery bytes instead of replacing possibly live new chunks after restart failure", async () => {
    writeOutput("dist", "old");
    await expect(
      runTransaction("stop", "restart", {
        root: workdir,
        lifecycle: async (command) => (command === "stop" ? 0 : 29),
        build: async () => {
          writeOutput("dist", "new");
          return { exitCode: 0 };
        },
      }),
    ).rejects.toThrow("previous output retained");
    expect(readOutput("dist")).toBe("new");
    expect(backups()).toHaveLength(1);
    expect(fs.readFileSync(path.join(workdir, backups()[0]!, "dist/marker"), "utf8")).toBe("old");
  });

  it("retains output and ownership without restarting when build writers are unjoined", async () => {
    writeOutput("dist", "old");
    const events: string[] = [];
    await expect(
      runTransaction("stop", "restart", {
        root: workdir,
        lifecycle: async (command) => {
          events.push(command);
          return 0;
        },
        build: async () => {
          writeOutput("dist", "partial");
          throw Object.assign(new Error("writer cleanup uncertain"), {
            processTreeState: "indeterminate",
          });
        },
      }),
    ).rejects.toThrow("Build writers have not settled");
    expect(events).toEqual(["stop"]);
    expect(readOutput("dist")).toBe("partial");
    expect(backups()).toHaveLength(1);
    expect(fs.existsSync(path.join(resolveDistArtifactLockPath(workdir), "owner.json"))).toBe(true);
  });

  it("does not restart or follow a replaced output root when restoration is unsafe", async () => {
    writeOutput("dist", "old");
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "marker"), "outside");
    const events: string[] = [];
    await expect(
      runTransaction("stop", "restart", {
        root: workdir,
        lifecycle: async (command) => {
          events.push(command);
          return 0;
        },
        build: async () => {
          fs.rmSync(path.join(workdir, "dist"), { recursive: true });
          fs.symlinkSync(outside, path.join(workdir, "dist"));
          return { exitCode: 17 };
        },
      }),
    ).rejects.toThrow("could not be fully restored");
    expect(events).toEqual(["stop"]);
    expect(fs.readFileSync(path.join(outside, "marker"), "utf8")).toBe("outside");
    expect(backups()).toHaveLength(1);
  });

  it("does not rm or restore output roots when the live-dist fence refuses before mutation", async () => {
    writeOutput("dist", "old");
    const events: string[] = [];
    const inode = fs.statSync(path.join(workdir, "dist", "marker")).ino;
    const code = await runTransaction("stop", "restart", {
      root: workdir,
      lifecycle: async (command) => {
        events.push(command);
        return 0;
      },
      build: async () => {
        events.push("build");
        writeOutput("dist", "old");
        fs.writeFileSync(path.join(workdir, "dist", "canary"), "after-backup");
        return { exitCode: 1, admissionRefused: true };
      },
    });
    expect(code).toBe(1);
    expect(events).toEqual(["stop", "build", "restart"]);
    expect(readOutput("dist")).toBe("old");
    expect(fs.readFileSync(path.join(workdir, "dist", "canary"), "utf8")).toBe("after-backup");
    expect(fs.statSync(path.join(workdir, "dist", "marker")).ino).toBe(inode);
    expect(backups()).toEqual([]);
  });

  it("restores prior output after a thrown build error and reports recovery restart failure", async () => {
    writeOutput("dist", "old");
    await expect(
      runTransaction("stop", "restart", {
        root: workdir,
        lifecycle: async (command) => (command === "stop" ? 0 : 23),
        build: async () => {
          writeOutput("dist", "partial");
          throw new Error("build failed");
        },
      }),
    ).rejects.toThrow("Previous build restored, but restart failed (23)");
    expect(readOutput("dist")).toBe("old");
    expect(backups()).toHaveLength(1);
  });

  it("refuses a symlinked package parent before stopping the Gateway", async () => {
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workdir, "packages"));
    const lifecycle: string[] = [];
    await expect(
      runTransaction("stop", "restart", {
        root: workdir,
        lifecycle: async (command) => {
          lifecycle.push(command);
          return 0;
        },
        build: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toThrow("symbolic link");
    expect(lifecycle).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
