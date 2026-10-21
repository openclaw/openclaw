import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDistArtifactLockPath } from "../scripts/lib/dist-artifact-ownership.mts";
import { listTsdownOutputRoots } from "../scripts/tsdown-build.mts";
import { runUpdateGatewayBuild } from "../scripts/update-gateway-build.mts";
import * as gatewayBindings from "../src/daemon/managed-gateway-bindings.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../src/infra/update-managed-service-handoff-lease.js";
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

async function runTransaction(fixture: {
  build: () => Promise<{ exitCode: number; admissionRefused?: true }>;
  lifecycle?: (command: string) => Promise<number>;
  events?: string[];
}) {
  buildMock.mockImplementation(fixture.build);
  lifecycleMock.mockImplementation(({ args }: { args: string[] }) => {
    fixture.events?.push(args[1]!);
    return fixture.lifecycle?.(args[1]!) ?? Promise.resolve(0);
  });
  return await runUpdateGatewayBuild("stop", "restart", shimDir);
}

let scratch: string;
let workdir: string;
let shimDir: string;
function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}
const read = (file: string) => fs.readFileSync(path.join(workdir, file), "utf8");
const exists = (file: string) => fs.existsSync(path.join(workdir, file));
const inode = (file: string) => fs.statSync(path.join(workdir, file)).ino;
const ownerExists = () =>
  fs.existsSync(path.join(resolveDistArtifactLockPath(workdir), "owner.json"));
const commandSuccess = (stdout = "") => ({
  code: 0,
  stdout,
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
  noOutputTimedOut: false,
});
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-build-"));
  workdir = path.join(scratch, "checkout");
  vi.stubEnv("TMPDIR", scratch);
  const database = resolveManagedUpdateLeaseDatabasePath();
  if (!fs.realpathSync(path.dirname(database)).startsWith(fs.realpathSync(scratch) + path.sep)) {
    throw new Error("Non-private handoff database");
  }
  shimDir = path.join(scratch, "bin");
  fs.mkdirSync(shimDir);
  vi.spyOn(process, "cwd").mockReturnValue(workdir);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("source update build output transaction", () => {
  const outputs = () => listTsdownOutputRoots();
  const writeOutput = (output: string, value: string) =>
    writeFiles(workdir, { [`${output}/marker`]: value });
  const readOutput = (output: string) => read(`${output}/marker`);
  const backups = () =>
    fs.readdirSync(workdir).filter((name) => name.startsWith(".update-build-backup."));
  beforeEach(() => {
    fs.mkdirSync(workdir);
    // TMPDIR can itself be inside the invoking checkout. Keep synthetic custody local.
    fs.mkdirSync(path.join(workdir, ".git"));
  });

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
      writeFiles(directory, {
        "dist/entry.js": "// fixture runtime\n",
        "dist/control-ui/index.html": "ready",
        "dist/build-info.json": JSON.stringify({ commit: sha, buildId: sha }),
        "dist/.buildstamp": JSON.stringify({ head: sha }),
        "dist/.runtime-postbuildstamp": JSON.stringify({ head: sha }),
        "dist/marker": marker,
      });
    };
    await git(workdir, "init", "--initial-branch=main");
    await git(workdir, "config", "user.name", "OpenClaw Test");
    await git(workdir, "config", "user.email", "openclaw@example.com");
    await git(workdir, "config", "commit.gpgsign", "false");
    writeFiles(workdir, {
      "package.json": JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        packageManager: "pnpm@12.4.0",
      }),
      "pnpm-workspace.yaml": "packages: []\n",
      ".gitignore": "dist/\nnode_modules/\n.artifacts/\n",
    });
    await git(workdir, "add", ".");
    await git(workdir, "commit", "-m", "original");
    const before = await git(workdir, "rev-parse", "HEAD");
    await git(workdir, "checkout", "-b", "target");
    writeFiles(workdir, { "target.txt": "candidate source\n" });
    await git(workdir, "add", "target.txt");
    await git(workdir, "commit", "-m", "target");
    const target = await git(workdir, "rev-parse", "HEAD");
    await git(workdir, "checkout", "main");
    writeRuntime(workdir, before, "original");
    writeFiles(workdir, { "node_modules/marker": "original dependency" });
    const inodes = () => ["dist/marker", "node_modules/marker"].map(inode);
    const originalInodes = inodes();
    let consumerLive = false;
    let imported = false;
    const observed: boolean[] = [];
    const siblingEnv = { HOME: path.join(scratch, "sibling-home"), OPENCLAW_PROFILE: "sibling" };
    vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([
      { env: siblingEnv },
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
          writeFiles(directory!, { "node_modules/marker": "candidate dependency" });
        }
        if (argv.includes("build")) {
          writeRuntime(directory!, await git(directory!, "rev-parse", "HEAD"), "candidate");
        }
        return commandSuccess(argv.includes("--version") ? "12.4.0" : "");
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
        expect(read("node_modules/marker")).toBe("original dependency");
      }
      return 0;
    });
    const [outcome] = await Promise.allSettled([
      runUpdateGatewayBuild("stop-selected", "restart-selected", shimDir, target),
    ]);
    expect(imported).toBe(true);
    expect(consumerLive).toBe(true);
    expect(lifecycle).toEqual(["stop-selected", "restart-selected"]);
    expect({
      outcome: outcome.status,
      rejection: outcome.status === "rejected" ? String(outcome.reason) : undefined,
      lastObservedConsumerLive: observed.at(-1),
      head: await git(workdir, "rev-parse", "HEAD"),
      targetSourceExists: exists("target.txt"),
      runtime: readOutput("dist"),
      dependency: read("node_modules/marker"),
      inodes: inodes(),
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
          return commandSuccess("a".repeat(40));
        });
      }
      lifecycleMock.mockClear();
      await expect(
        runUpdateGatewayBuild("stop", "restart", shimDir, "a".repeat(40)),
      ).rejects.toThrow();
      const owner = resolveDistArtifactLockPath(workdir);
      expect(fs.existsSync(path.join(owner, "owner.json"))).toBe(uncertain);
      expect(fs.existsSync(path.join(owner, "unjoined"))).toBe(uncertain);
      expect(command).toHaveBeenCalledTimes(1);
      expect(lifecycleMock).not.toHaveBeenCalled();
    },
  );

  it.each(["exit", "non-Error rejection", "recovery failure"])(
    "restores every output before restarting after build %s",
    async (mode) => {
      const oldRoots = outputs().slice(0, -1);
      for (const output of oldRoots) {
        writeOutput(output, `old:${output}`);
      }
      const events: string[] = [];
      const result = runTransaction({
        lifecycle: async (command) => {
          expect(ownerExists()).toBe(true);
          events.push(command);
          if (command === "restart") {
            for (const output of oldRoots) {
              expect(readOutput(output)).toBe(`old:${output}`);
            }
            expect(exists(outputs().at(-1)!)).toBe(false);
          }
          return command === "restart" && mode === "recovery failure" ? 23 : 0;
        },
        build: async () => {
          events.push("build");
          for (const output of outputs()) {
            fs.rmSync(path.join(workdir, output), { recursive: true, force: true });
            writeOutput(output, "partial");
          }
          if (mode !== "exit") {
            return vi
              .fn<() => Promise<{ exitCode: number }>>()
              .mockRejectedValue(
                mode === "non-Error rejection" ? "compiler failed" : new Error("build failed"),
              )();
          }
          return { exitCode: 17 };
        },
      });
      if (mode === "exit") {
        await expect(result).resolves.toBe(17);
      } else if (mode === "non-Error rejection") {
        await expect(result).rejects.toMatchObject({
          message: "Build failed",
          cause: "compiler failed",
        });
      } else {
        await expect(result).rejects.toThrow("Previous build restored, but restart failed (23)");
      }
      expect(events).toEqual(["stop", "build", "restart"]);
      for (const output of oldRoots) {
        expect(readOutput(output)).toBe(`old:${output}`);
      }
      expect(backups()).toHaveLength(mode === "recovery failure" ? 1 : 0);
    },
  );

  it.each([0, 29])(
    "keeps new output and retains recovery bytes only after restart failure (%s)",
    async (restartCode) => {
      writeOutput("dist/control-ui", "preserved UI");
      writeOutput("dist", "old");
      const result = runTransaction({
        lifecycle: async (command) => (command === "stop" ? 0 : restartCode),
        build: async () => {
          expect(readOutput("dist/control-ui")).toBe("preserved UI");
          writeOutput("dist", "new");
          return { exitCode: 0 };
        },
      });
      if (restartCode) {
        await expect(result).rejects.toThrow("previous output retained");
      } else {
        await expect(result).resolves.toBe(0);
      }
      expect(readOutput("dist")).toBe("new");
      expect(readOutput("dist/control-ui")).toBe("preserved UI");
      expect(backups()).toHaveLength(restartCode ? 1 : 0);
      if (restartCode) {
        expect(read(`${backups()[0]!}/dist/marker`)).toBe("old");
      }
    },
  );

  it("does not build or replace outputs after a failed stop", async () => {
    writeOutput("dist", "old");
    const build = vi.fn(async () => ({ exitCode: 0 }));
    const code = await runTransaction({
      lifecycle: async () => 23,
      build,
    });
    expect(code).toBe(23);
    expect(build).not.toHaveBeenCalled();
    expect(readOutput("dist")).toBe("old");
    expect(backups()).toEqual([]);
  });

  it("retains output and ownership without restarting when build writers are unjoined", async () => {
    writeOutput("dist", "old");
    const events: string[] = [];
    await expect(
      runTransaction({
        events,
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
    expect(ownerExists()).toBe(true);
  });

  it("does not restart or follow a replaced output root when restoration is unsafe", async () => {
    writeOutput("dist", "old");
    const outside = path.join(scratch, "outside");
    writeFiles(outside, { marker: "outside" });
    const events: string[] = [];
    await expect(
      runTransaction({
        events,
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
    const originalInode = inode("dist/marker");
    const code = await runTransaction({
      events,
      build: async () => {
        events.push("build");
        writeOutput("dist", "old");
        writeFiles(workdir, { "dist/canary": "after-backup" });
        return { exitCode: 1, admissionRefused: true };
      },
    });
    expect(code).toBe(1);
    expect(events).toEqual(["stop", "build", "restart"]);
    expect(readOutput("dist")).toBe("old");
    expect(read("dist/canary")).toBe("after-backup");
    expect(inode("dist/marker")).toBe(originalInode);
    expect(backups()).toEqual([]);
  });

  it("refuses a symlinked package parent before stopping the Gateway", async () => {
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workdir, "packages"));
    const lifecycle: string[] = [];
    await expect(
      runTransaction({
        events: lifecycle,
        build: async () => ({ exitCode: 0 }),
      }),
    ).rejects.toThrow("symbolic link");
    expect(lifecycle).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
