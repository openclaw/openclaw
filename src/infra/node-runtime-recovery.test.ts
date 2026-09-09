import {
  ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { isUsableNode, recoverNodeRuntime } from "../../node-runtime-recovery.mjs";
import { SQLITE_CAPABILITY_PROBE } from "../../node-sqlite.mjs";
import { withTempDir } from "../test-utils/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const mocks = vi.hoisted(() => ({
  currentAdmitted: false,
  admissible: new Set<string>(),
  virtualPaths: new Map<string, string>(),
  probe:
    vi.fn<
      (
        file: string,
        args: string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ) => SpawnSyncReturns<string>
    >(),
  spawn: vi.fn<(file: string, args: string[], options: SpawnOptions) => ChildProcess>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  spawnSync: mocks.probe,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (filename: string) =>
      mocks.virtualPaths.get(filename) ?? actual.realpathSync(filename),
  };
});
vi.mock("../../node-sqlite.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../node-sqlite.mjs")>()),
  detectCurrentSqliteCapabilities: () => ({
    available: true,
    version: "3.51.3",
    text: mocks.currentAdmitted,
    blob: true,
    json: true,
  }),
}));

const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
const hostPlatform = process.platform;
const exitSentinel = new Error("replacement exited");
let child: ChildProcess;
let exitSpy: MockInstance<typeof process.exit>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  mockProcessPlatform("linux");
  mocks.currentAdmitted = false;
  mocks.admissible.clear();
  mocks.virtualPaths.clear();
  mocks.probe.mockReset();
  mocks.spawn.mockReset();
  mocks.probe.mockImplementation((filename) => ({
    pid: 100,
    status: 0,
    signal: null,
    output: [],
    stdout: JSON.stringify({
      version: "24.19.0",
      probe: {
        available: true,
        version: "3.51.3",
        text: mocks.admissible.has(filename),
        blob: true,
        json: true,
      },
    }),
    stderr: "",
  }));
  child = new ChildProcess();
  mocks.spawn.mockReturnValue(child);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw exitSentinel;
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.argv = [
    process.execPath,
    "/fixture/dist/index.js",
    "doctor",
    "--non-interactive",
    "--fix",
  ];
  process.execArgv = [];
  vi.stubEnv("CI", "1");
  for (const key of [
    "OPENCLAW_NODE_UPDATE_RESPAWNED",
    "OPENCLAW_PROFILE",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  if (child.listenerCount("exit")) {
    expect(() => child.emit("exit", 0, null)).toThrow(exitSentinel);
  }
  process.argv = originalArgv;
  process.execArgv = originalExecArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function writeFixture(filename: string, text = "") {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, text);
  return filename;
}

async function withRecoveryHome(run: (home: string) => Promise<void>) {
  await withTempDir("openclaw-node-recovery-", async (directory) => {
    const home = await fs.realpath(directory);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", path.join(home, "bin"));
    vi.stubEnv("NVM_DIR", path.join(home, ".nvm"));
    vi.stubEnv("FNM_DIR", path.join(home, ".fnm"));
    vi.stubEnv("VOLTA_HOME", path.join(home, ".volta"));
    await run(home);
  });
}

async function expectRecoveryStarted(home: string) {
  void recoverNodeRuntime({ homeDir: home });
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
}

describe("runtime recovery discovery", () => {
  it.each([
    [0, "cached OpenClaw runtime"],
    [1, "managed Gateway service"],
    [2, "PATH"],
    [3, "nvm default"],
    [4, "fnm default"],
    [5, "Volta default"],
    [6, "Homebrew node@26"],
    [7, "Homebrew node@24"],
  ] as const)("selects the first admissible runtime: %s %s", async (index, source) => {
    await withRecoveryHome(async (home) => {
      const candidates = await Promise.all(
        [
          ".openclaw/tools/cli-node/tools/node/bin/node",
          "service/bin/node",
          "bin/node",
          ".nvm/versions/node/v24.19.0/bin/node",
          ".fnm/aliases/default/bin/node",
          ".volta/tools/image/node/24.19.0/bin/node",
          "brew26/bin/node",
          "brew24/bin/node",
        ].map((relative) => writeFixture(path.join(home, relative))),
      );
      await writeFixture(
        path.join(home, ".config/systemd/user/openclaw-gateway.service"),
        `[Service]\nExecStart="${expectDefined(candidates[1], "service candidate").replaceAll("\\", "\\\\")}" /fixture/dist/index.js gateway run\n`,
      );
      await writeFixture(path.join(home, ".nvm/alias/default"), "lts/test\n");
      await writeFixture(path.join(home, ".nvm/alias/lts/test"), "24\n");
      await writeFixture(
        path.join(home, ".volta/tools/user/platform.json"),
        JSON.stringify({ node: { runtime: "24.19.0" } }),
      );
      for (const prefix of ["/opt/homebrew", "/usr/local"]) {
        mocks.virtualPaths.set(
          path.join(prefix, "opt", "node@26", "bin", "node"),
          expectDefined(candidates[6], "Node 26 candidate"),
        );
        mocks.virtualPaths.set(
          path.join(prefix, "opt", "node@24", "bin", "node"),
          expectDefined(candidates[7], "Node 24 candidate"),
        );
      }
      for (const candidate of candidates.slice(index)) {
        mocks.admissible.add(candidate);
      }

      await expectRecoveryStarted(home);

      expect(mocks.probe.mock.calls.map(([filename]) => filename)).toEqual(
        candidates.slice(0, index + 1),
      );
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidates[index]);
      expect(stderrSpy).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`(${source}; current Node failed runtime admission)`),
      );
    });
  });

  it.each(["direct", "shell wrapper", "executable wrapper"])(
    "finds the profiled launchd runtime through a %s command",
    async (form) => {
      mockProcessPlatform("darwin");
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(path.join(home, "service & runtime/bin/node"));
        mocks.admissible.add(candidate);
        process.argv = [
          process.execPath,
          "/fixture/openclaw.mjs",
          "--profile",
          "fixture",
          "doctor",
        ];
        const wrapper = path.join(home, "service-env/ai.openclaw.fixture-env-wrapper.sh");
        const envFile = path.join(home, "service-env/ai.openclaw.fixture.env");
        const prefix =
          form === "direct"
            ? []
            : form === "shell wrapper"
              ? ["/bin/sh", wrapper, envFile]
              : [wrapper, envFile];
        const args = [...prefix, candidate, "/fixture/dist/index.js", "gateway"];
        await writeFixture(
          path.join(home, "Library/LaunchAgents/ai.openclaw.fixture.plist"),
          `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${arg.replaceAll("&", "&amp;")}</string>`).join("")}</array>`,
        );

        await expectRecoveryStarted(home);

        expect(mocks.probe.mock.calls.map(([filename]) => filename)).toEqual([candidate]);
        expect(mocks.spawn.mock.calls[0]?.[0]).toBe(candidate);
      });
    },
  );

  it("ignores PATH aliases for the running executable and probes each other binary once", async () => {
    await withRecoveryHome(async (home) => {
      await fs.mkdir(path.join(home, "bin"));
      if (hostPlatform === "win32") {
        mocks.virtualPaths.set(path.join(home, "bin/node"), await fs.realpath(process.execPath));
      } else {
        await fs.symlink(process.execPath, path.join(home, "bin/node"));
      }
      const replacement = await writeFixture(path.join(home, "replacement/bin/node"));
      const alternate = path.join(home, "alternate/bin/node");
      await fs.mkdir(path.dirname(alternate), { recursive: true });
      if (hostPlatform === "win32") {
        mocks.virtualPaths.set(alternate, replacement);
      } else {
        await fs.symlink(replacement, alternate);
      }
      vi.stubEnv(
        "PATH",
        [path.join(home, "bin"), path.dirname(alternate), path.dirname(replacement)].join(
          path.delimiter,
        ),
      );

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);

      expect(mocks.probe.mock.calls.filter(([filename]) => filename === replacement)).toHaveLength(
        1,
      );
      expect(mocks.probe.mock.calls.some(([filename]) => filename === process.execPath)).toBe(
        false,
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it.each(["already admitted", "replacement child"])(
    "does not discover for an %s",
    async (reason) => {
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(path.join(home, "bin/node"));
        mocks.admissible.add(candidate);
        mocks.currentAdmitted = reason === "already admitted";
        if (reason === "replacement child") {
          vi.stubEnv("OPENCLAW_NODE_UPDATE_RESPAWNED", "1");
        }

        expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
        expect(mocks.probe).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    ["webhooks", "gmail", "run"],
    ["--profile", "fixture", "webhooks", "gmail", "run"],
    ["webhooks", "--log-level=debug", "gmail", "--no-color", "run"],
    ["hooks", "relay", "--relay-id", "fixture"],
  ])("keeps exact-PID invocation %j in its original process", async (...args) => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin/node"));
      mocks.admissible.add(candidate);
      process.argv = [process.execPath, "/fixture/openclaw.mjs", ...args];

      expect(await recoverNodeRuntime({ homeDir: home })).toBe(false);
      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });
  });

  it.each([0, 7])(
    "preserves the invocation and propagates replacement exit %s",
    async (exitCode) => {
      await withRecoveryHome(async (home) => {
        const candidate = await writeFixture(path.join(home, "bin/node"));
        mocks.admissible.add(candidate);
        process.execArgv = ["--trace-warnings"];
        vi.stubEnv("OPENCLAW_TEST_VALUE", "preserved");
        vi.stubEnv("NODE_OPTIONS", "--no-warnings");
        const originalEnv = { ...process.env };
        const originalCwd = process.cwd();

        await expectRecoveryStarted(home);

        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
          candidate,
          ["--trace-warnings", "/fixture/dist/index.js", "doctor", "--non-interactive", "--fix"],
          { stdio: "inherit", env: { ...originalEnv, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" } },
        );
        expect(process.cwd()).toBe(originalCwd);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(() => child.emit("exit", exitCode, null)).toThrow(exitSentinel);
        expect(exitSpy).toHaveBeenCalledExactlyOnceWith(exitCode);
      });
    },
  );
});

describe("candidate admission probe", () => {
  it("runs only the shared bounded probe with a sanitized environment", async () => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin/node"));
      mocks.admissible.add(candidate);
      for (const key of [
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "OPENCLAW_TEST_SECRET",
      ]) {
        vi.stubEnv(key, "synthetic-untrusted-value");
      }
      vi.stubEnv("SystemRoot", "/fixture/windows");
      vi.stubEnv("TMPDIR", path.join(home, "tmp"));

      expect(isUsableNode(candidate)).toBe(true);

      expect(mocks.probe).toHaveBeenCalledOnce();
      const [, args, options] = expectDefined(mocks.probe.mock.calls[0], "runtime probe call");
      expect(args).toEqual(["-e", expect.stringContaining(SQLITE_CAPABILITY_PROBE)]);
      expect(options).toMatchObject({
        timeout: 5_000,
        maxBuffer: 65_536,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          NODE_NO_WARNINGS: "1",
          SystemRoot: "/fixture/windows",
          TMPDIR: path.join(home, "tmp"),
        },
      });
      expect(
        Object.keys(options.env ?? {}).every((key) =>
          /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR|NODE_NO_WARNINGS)$/i.test(key),
        ),
      ).toBe(true);
    });
  });

  it.each(["timeout", "malformed response", "failed exit"])("rejects %s", async (failure) => {
    await withRecoveryHome(async (home) => {
      const candidate = await writeFixture(path.join(home, "bin/node"));
      mocks.admissible.add(candidate);
      mocks.probe.mockReturnValue({
        pid: 100,
        status: failure === "timeout" ? null : failure === "failed exit" ? 1 : 0,
        signal: failure === "timeout" ? "SIGTERM" : null,
        output: [],
        stdout:
          failure === "malformed response"
            ? "not JSON"
            : JSON.stringify({
                version: "24.19.0",
                probe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
              }),
        stderr: "",
      });

      expect(isUsableNode(candidate)).toBe(false);
    });
  });
});
