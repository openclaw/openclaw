import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDistArtifactLockPath } from "../scripts/lib/dist-artifact-ownership.mts";
import { listTsdownOutputRoots } from "../scripts/tsdown-build.mts";
import { runUpdateGatewayBuild } from "../scripts/update-gateway-build.mts";

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
    build: () => Promise<{ exitCode: number }>;
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let scratch: string;
let workdir: string;
let shimDir: string;
let invocationLog: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function writeShim(name: string, body: string) {
  const file = path.join(shimDir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function runUpdater(overrides: Record<string, string> = {}) {
  const env = { ...process.env, ...overrides };
  for (const name of ["OPENCLAW_UPDATE_RESTART_CMD", "OPENCLAW_UPDATE_STOP_CMD"]) {
    if (!Object.hasOwn(overrides, name)) {
      delete env[name];
    }
  }
  return spawnSync("/bin/bash", [path.join(workdir, "scripts/update-gateway.sh")], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      UPDATE_TEST_LOG: invocationLog,
      UPDATE_TEST_BIN: shimDir,
    },
  });
}

const calls = () =>
  fs.existsSync(invocationLog)
    ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)
    : [];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-gateway-"));
  workdir = path.join(scratch, "checkout");
  shimDir = path.join(scratch, "bin");
  invocationLog = path.join(scratch, "calls");
  fs.mkdirSync(shimDir);
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("source updater lifecycle preflight", () => {
  beforeEach(() => {
    const seed = path.join(scratch, "seed");
    const origin = path.join(scratch, "origin.git");
    fs.mkdirSync(path.join(seed, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts/update-gateway.sh"),
      path.join(seed, "scripts/update-gateway.sh"),
    );
    fs.writeFileSync(
      path.join(seed, "package.json"),
      JSON.stringify({ packageManager: "pnpm@12.4.0" }),
    );
    fs.writeFileSync(path.join(seed, ".gitignore"), "dist/\ndist-runtime/\n");
    git(seed, "init", "-q", "-b", "main");
    git(seed, "add", ".");
    git(
      seed,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    git(scratch, "clone", "-q", "--bare", seed, origin);
    git(scratch, "clone", "-q", origin, workdir);
    writeShim("git", 'echo "git $*" >> "$UPDATE_TEST_LOG"\nPATH="${PATH#*:}" exec git "$@"');
    writeShim(
      "corepack",
      'echo "corepack $*" >> "$UPDATE_TEST_LOG"\nln -s "$UPDATE_TEST_BIN/pnpm" "$3/pnpm"',
    );
    writeShim(
      "pnpm",
      'if [ "$1" = --version ]; then echo 12.4.0; exit 0; fi\necho "pnpm $*" >> "$UPDATE_TEST_LOG"\nif [ "$1" = build ]; then mkdir -p dist; echo new > dist/marker; exit "${UPDATE_TEST_BUILD_EXIT:-0}"; fi',
    );
    writeShim("openclaw", 'echo "openclaw $*" >> "$UPDATE_TEST_LOG"');
  });

  it.each([
    ["stop only", { OPENCLAW_UPDATE_STOP_CMD: "custom-stop" }],
    ["restart only", { OPENCLAW_UPDATE_RESTART_CMD: "custom-restart" }],
    [
      "blank stop",
      { OPENCLAW_UPDATE_STOP_CMD: " \t\n", OPENCLAW_UPDATE_RESTART_CMD: "custom-restart" },
    ],
    [
      "blank restart",
      { OPENCLAW_UPDATE_STOP_CMD: "custom-stop", OPENCLAW_UPDATE_RESTART_CMD: " \t\n" },
    ],
    [
      "manual with automatic stop",
      { OPENCLAW_UPDATE_STOP_CMD: "custom-stop", OPENCLAW_UPDATE_RESTART_CMD: "" },
    ],
  ] satisfies Array<[string, Record<string, string>]>)(
    "rejects %s before effects",
    (_name, overrides) => {
      const result = runUpdater(overrides);
      expect(result.status).toBe(1);
      expect(calls()).toEqual([]);
    },
  );

  it.each([
    ["defaults", {}, "openclaw gateway stop --force", "openclaw gateway restart"],
    [
      "trimmed custom pair",
      {
        OPENCLAW_UPDATE_STOP_CMD: "  custom-stop\t",
        OPENCLAW_UPDATE_RESTART_CMD: "\ncustom-restart  ",
      },
      "custom-stop",
      "custom-restart",
    ],
  ] satisfies Array<[string, Record<string, string>, string, string]>)(
    "passes %s to the owned build adapter",
    (_name, overrides, stop, restart) => {
      const realNode = process.execPath;
      writeShim(
        "node",
        [
          'if [ "$1" = --import ]; then',
          '  printf "adapter:%s:%s:%s\\n" "$4" "$5" "$6" >> "$UPDATE_TEST_LOG"',
          "  exit 0",
          "fi",
          `exec '${realNode.replaceAll("'", "'\\''")}' "$@"`,
        ].join("\n"),
      );
      const result = runUpdater(overrides);
      expect(result.status, result.stderr).toBe(0);
      expect(calls().some((call) => call.startsWith(`adapter:${stop}:${restart}:`))).toBe(true);
      expect(calls()).not.toContain("pnpm build");
    },
  );

  it.each([0, 17])("keeps exact-empty restart as manual lifecycle (build exit %s)", (exit) => {
    const result = runUpdater({
      OPENCLAW_UPDATE_RESTART_CMD: "",
      UPDATE_TEST_BUILD_EXIT: String(exit),
    });
    expect(result.status, result.stderr).toBe(exit);
    expect(calls()).toContain("pnpm build");
    expect(calls().some((call) => call.startsWith("openclaw "))).toBe(false);
  });
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
