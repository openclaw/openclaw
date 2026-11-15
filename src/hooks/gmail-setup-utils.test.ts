import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const itUnix = process.platform === "win32" ? it.skip : it;
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));

// mock-isolation: setup command results are synthetic and must not invoke real cloud tools.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommand }));

const success = createCommandResult();
const tailscaleStatus = { ...success, stdout: '{"Self":{"DNSName":"fixture.example."}}' };
const progress = Array.from({ length: 1000 }, (_, i) => `progress ${i}`).join("\r");
const noisy = {
  ...success,
  code: 7,
  stdout: `${"x".repeat(30_000)}\r\nstdout final detail 🦞\r\n`,
  stderr: `${progress}\r\n\u001b[31mstderr final detail\u001b[0m\r\n`,
};

let utils: typeof import("./gmail-setup-utils.js");
let configEval: typeof import("../shared/config-eval.js");
beforeEach(async () => {
  runCommand.mockReset();
  vi.resetModules();
  configEval = await import("../shared/config-eval.js");
  utils = await import("./gmail-setup-utils.js");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function writeExecutable(executable: string): Promise<string> {
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executable, 0o755);
  return executable;
}

const pythonProbe = (executable: string, version = "3.12") => ({
  ...success,
  stdout: `${executable}\n${version}\n`,
});

it.each([true, false])("checks the installed binary (created=%s)", async (createsBinary) => {
  await withTestDir({ prefix: "openclaw-dependency-probe-" }, async (root) => {
    const binDir = path.join(root, "bin");
    await writeExecutable(path.join(binDir, "brew"));
    await withEnvAsync({ PATH: binDir, XDG_CONFIG_HOME: path.join(root, "config") }, () =>
      withMockedPlatform("darwin", async () => {
        runCommand.mockImplementation(async (argv: string[]) => {
          expect(argv).toEqual(["brew", "install", "fixture-probe-formula"]);
          if (createsBinary) {
            await writeExecutable(path.join(binDir, "fixture-gmail-tool"));
          }
          return success;
        });

        const install = () =>
          utils.ensureDependency("fixture-gmail-tool", ["fixture-probe-formula"]);
        if (createsBinary) {
          await expect(install()).resolves.toBeUndefined();
          await expect(install()).resolves.toBeUndefined();
        } else {
          await expect(install()).rejects.toThrow(
            "fixture-gmail-tool still not available after brew install",
          );
        }
        expect(process.env.PATH).toBe(binDir);
        expect(runCommand).toHaveBeenCalledTimes(1);
      }),
    );
  });
});

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected command failure");
}

const inheritedPythonControls = {
  CLOUDSDK_PYTHON: "/tmp/attacker-python",
  CLOUDSDK_PYTHON_ARGS: "-cprint('attacker')",
};

async function checkPython(versions: readonly string[]) {
  await withTestDir({ prefix: "openclaw-gcloud-python-" }, async (root) => {
    const python = path.join(root, "Python Runtime", "python-real");
    if (versions.length) {
      await writeExecutable(python);
    }
    const shimDirs = [];
    for (const [index, version] of versions.entries()) {
      const shimDir = path.join(root, `shim-${index}`);
      shimDirs.push(shimDir);
      await writeExecutable(path.join(shimDir, "python3"));
      const resolved = version === "3.12" ? python : path.join(root, `python-${version}`);
      if (version === "3.9") {
        await writeExecutable(resolved);
      }
      runCommand.mockResolvedValueOnce(pythonProbe(resolved, version));
    }
    runCommand.mockResolvedValue(success);
    await withEnvAsync(
      {
        ...inheritedPythonControls,
        PATH: [...shimDirs, ...(versions.length ? ["/usr/bin"] : [])].join(path.delimiter),
      },
      async () => {
        await utils.runGcloud(["config", "list"]);
        expect(runCommand).toHaveBeenLastCalledWith(["gcloud", "config", "list"], {
          timeoutMs: 120_000,
          env: {
            CLOUDSDK_PYTHON: versions.length ? python : undefined,
            CLOUDSDK_PYTHON_ARGS: undefined,
          },
        });
        if (!versions.length) {
          expect(runCommand).toHaveBeenCalledTimes(1);
        }
      },
    );
  });
}

itUnix(
  "skips unsupported Python versions and overrides inherited controls",
  async () => checkPython(["3.9", "3.15", "3.12"]),
  60_000,
);
itUnix("unsets inherited controls without an interpreter", async () => checkPython([]));

it("passes abort signal to tailscale status and serve commands", async () => {
  const { signal } = new AbortController();
  runCommand.mockResolvedValueOnce(tailscaleStatus).mockResolvedValueOnce(success);

  await utils.ensureTailscaleEndpoint({ mode: "serve", path: "/gmail-pubsub", port: 8788, signal });

  const options = { timeoutMs: 30_000, signal };
  expect(runCommand.mock.calls).toEqual([
    [["tailscale", "status", "--json"], options],
    [["tailscale", "serve", "--bg", "--set-path", "/gmail-pubsub", "--yes", "8788"], options],
  ]);
});

describe("Gmail setup diagnostics and decisions", () => {
  const hasBinaryMock = vi.fn<(bin: string) => boolean>();
  beforeEach(() => {
    vi.stubEnv("PATH", "");
    hasBinaryMock.mockReset().mockReturnValue(true);
    vi.spyOn(configEval, "hasBinary").mockImplementation(hasBinaryMock);
  });

  it.each(["gcloud command", "brew install for gog", "tailscale serve"])(
    "%s reports its operation and stream tails without exposing arguments",
    async (boundary) => {
      runCommand.mockResolvedValue(noisy);
      const run = async () => {
        if (boundary === "brew install for gog") {
          hasBinaryMock.mockImplementation((bin: string) => bin === "brew");
          return withMockedPlatform("darwin", () => utils.ensureDependency("gog", ["gogcli"]));
        }
        if (boundary === "tailscale serve") {
          runCommand.mockResolvedValueOnce(tailscaleStatus);
          return utils.ensureTailscaleEndpoint({ mode: "serve", path: "/gmail", port: 8788 });
        }
        return utils.runGcloud(["--push-endpoint", "https://example.com/?token=do-not-echo-argv"]);
      };
      const { message } = await rejection(run);
      expect(message).toContain(boundary);
      expect(message).toContain("stdout final detail 🦞");
      expect(message).toContain("stderr final detail");
      expect(message).not.toContain("do-not-echo-argv");
    },
  );

  it("bounds invalid JSON diagnostics while retaining the parser cause and successful exit metadata", async () => {
    runCommand.mockResolvedValue({
      ...noisy,
      code: 0,
      stdout: `{"value":"${"x".repeat(30_000)}"}invalid-tail`,
    });
    const error = await rejection(() =>
      utils.ensureTailscaleEndpoint({ mode: "serve", path: "/gmail", port: 8788 }),
    );
    expect(error.message.length).toBeLessThan(3000);
    expect(error.message).toContain("returned invalid JSON");
    expect(error.message).toContain("code=0");
    expect(error.message).toContain("stdout:");
    expect(error.message).toContain("invalid-tail");
    expect(error.message).toContain("stderr final detail");
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it("logs in when the active account list is empty", async () => {
    runCommand.mockResolvedValueOnce({ ...success, stdout: " \n" }).mockResolvedValue(success);
    await utils.ensureGcloudAuth();
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1]?.[0].slice(1)).toEqual(["auth", "login"]);
  });

  it.each([0, 1])("provisions only according to describe exit code %i", async (code) => {
    runCommand.mockResolvedValueOnce({ ...success, code }).mockResolvedValue(success);
    await utils.ensureTopic("project", "topic");
    expect(runCommand.mock.calls.map(([args]) => args.slice(1, 4))).toEqual(
      code === 0
        ? [["pubsub", "topics", "describe"]]
        : [
            ["pubsub", "topics", "describe"],
            ["pubsub", "topics", "create"],
          ],
    );
    runCommand
      .mockReset()
      .mockResolvedValueOnce({ ...success, code })
      .mockResolvedValue(success);
    await utils.ensureSubscription("project", "subscription", "topic", "https://example.com/push");
    expect(runCommand.mock.calls.map(([args]) => args.slice(1, 4))).toEqual([
      ["pubsub", "subscriptions", "describe"],
      ["pubsub", "subscriptions", code === 0 ? "update" : "create"],
    ]);
  });

  it.each([
    { state: "missing", platform: "linux", expected: "gog not installed; install it and retry" },
    {
      state: "no brew",
      platform: "darwin",
      expected: "Homebrew not installed (install brew and retry)",
    },
  ] as const)("retains dependency guidance: $state", async ({ platform, expected }) => {
    hasBinaryMock.mockReturnValue(false);
    runCommand.mockResolvedValue(success);
    await withMockedPlatform(platform, async () => {
      await expect(utils.ensureDependency("gog", ["gogcli"])).rejects.toThrow(expected);
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
