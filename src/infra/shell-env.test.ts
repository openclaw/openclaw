import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type * as KillTreeModule from "../process/kill-tree.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

type ShellEnvModule = typeof import("./shell-env.js");

let api: ShellEnvModule;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hostPlatform = process.platform;
const syncExec = vi.fn<typeof execFileSync>();

beforeEach(async () => {
  syncExec.mockReset();
  syncExec.mockImplementation(() => {
    throw new Error("unexpected synchronous probe");
  });
  vi.doMock("node:child_process", () => ({ ...childProcess, execFileSync: syncExec }));
  vi.resetModules();
  api = await import("./shell-env.js");
});

afterEach(() => {
  vi.doUnmock("node:child_process");
});

describe("async login-shell PATH preparation", () => {
  beforeEach(() => {
    mockProcessPlatform("linux");
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.doUnmock("../process/kill-tree.js");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function holdProbe() {
    type ShellProcess = childProcess.ChildProcessByStdio<null, PassThrough, PassThrough>;
    type ShellSpawnOptions = childProcess.SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">;
    let child: ShellProcess;
    const kill = vi.fn(() => true);
    const exec = vi.fn<
      (command: string, args: readonly string[], options: ShellSpawnOptions) => ShellProcess
    >(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdio: ShellProcess["stdio"] = [null, stdout, stderr, null, null];
      child = Object.assign(new ChildProcess(), { stdin: null, stdout, stderr, stdio, kill });
      return child;
    });
    vi.doMock("node:child_process", () => ({
      ...childProcess,
      spawn: exec,
      execFileSync: syncExec,
    }));
    vi.resetModules();
    api = await import("./shell-env.js");
    return {
      exec,
      sync: syncExec,
      kill,
      get child() {
        return child;
      },
      finish: (error: Error | null, output = "\0PATH=/shell/bin\0") => {
        if (error) {
          child.emit("error", error);
        }
        child.stdout?.emit("data", Buffer.from(output));
        child.emit("exit", error ? 1 : 0, null);
        child.emit("close", error ? 1 : 0, null);
      },
    };
  }

  async function expectProbeRetry(
    probe: Awaited<ReturnType<typeof holdProbe>>,
    options: Parameters<typeof api.prepareShellPathFromLoginShell>[0],
  ) {
    const retry = api.prepareShellPathFromLoginShell(options);
    expect(probe.exec).toHaveBeenCalledTimes(2);
    probe.finish(null);
    await expect(retry).resolves.toBe("/shell/bin");
    expect(api.getShellPathFromLoginShell(options)).toBe("/shell/bin");
    expect(probe.sync).not.toHaveBeenCalled();
  }

  it("shares an in-flight probe and makes later synchronous resolution immediate", async () => {
    const probe = await holdProbe();
    const options = {
      env: { PATH: "/daemon/bin", SHELL: "relative-shell" },
    };
    const first = api.prepareShellPathFromLoginShell(options);
    const second = api.prepareShellPathFromLoginShell(options);
    expect(second).toBe(first);
    expect(probe.exec).toHaveBeenCalledOnce();
    expect(probe.exec.mock.calls[0]?.[0]).toBe("/bin/sh");
    probe.finish(null, "startup banner\n\0PATH= /shell/bin \0BAD\0");
    await expect(first).resolves.toBe("/shell/bin");
    expect(api.getShellPathFromLoginShell(options)).toBe("/shell/bin");
    await expect(api.prepareShellPathFromLoginShell(options)).resolves.toBe("/shell/bin");
    expect(probe.sync).not.toHaveBeenCalled();
    expect(probe.exec).toHaveBeenCalledOnce();
  });

  it("preserves a synchronous result published during preparation", async () => {
    const probe = await holdProbe();
    const options = { env: {} };
    const pending = api.prepareShellPathFromLoginShell(options);
    probe.sync.mockReturnValue(Buffer.from("\0PATH=/sync/bin\0"));
    expect(api.getShellPathFromLoginShell(options)).toBe("/sync/bin");
    probe.finish(null);
    await expect(pending).resolves.toBe("/sync/bin");
    expect(api.getShellPathFromLoginShell(options)).toBe("/sync/bin");
  });

  it.each(["spawn error", "timeout", "stdout overflow", "combined output overflow"])(
    "retries %s without caching the failed preparation",
    async (failure) => {
      const probe = await holdProbe();
      const options = { env: {} };
      const pending = api.prepareShellPathFromLoginShell(options);
      let error: Error | null = null;
      if (failure === "spawn error") {
        error = new Error("ENOENT");
      } else if (failure === "timeout") {
        Object.defineProperty(probe.child, "killed", { value: true });
      } else {
        if (failure === "combined output overflow") {
          probe.child.stdout?.emit("data", Buffer.alloc(1024 * 1024));
          probe.child.stderr?.emit("data", Buffer.alloc(1024 * 1024 + 1));
        } else {
          probe.child.stdout?.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1));
        }
        expect(probe.kill).toHaveBeenCalledOnce();
      }
      probe.finish(error);
      expect(probe.child.stdout?.destroyed).toBe(true);
      expect(probe.child.stderr?.destroyed).toBe(true);
      await expect(pending).resolves.toBeNull();
      await expectProbeRetry(probe, options);
    },
  );

  it.each([
    ["async", "linux", "\0PATH= \0", 1],
    ["async", "linux", "unframed PATH=/shell/bin", 1],
    ["async", "win32", "\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0", 0],
    ["sync", "linux", "\0PATH=   \0HOME=/tmp\0", 1],
    ["sync", "win32", "\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0", 0],
  ] as const)("caches a null %s PATH on %s for %j", async (mode, platform, output, calls) => {
    mockProcessPlatform(platform);
    if (mode === "async") {
      const probe = await holdProbe();
      const options = { env: {} };
      const pending = api.prepareShellPathFromLoginShell(options);
      if (calls > 0) {
        probe.finish(null, output);
      }
      await expect(pending).resolves.toBeNull();
      expect(api.getShellPathFromLoginShell(options)).toBeNull();
      expect(probe.exec).toHaveBeenCalledTimes(calls);
      expect(probe.sync).not.toHaveBeenCalled();
    } else {
      const exec = syncExec.mockReturnValue(Buffer.from(output));
      const options = { env: {} };
      expect(api.getShellPathFromLoginShell(options)).toBeNull();
      expect(api.getShellPathFromLoginShell(options)).toBeNull();
      expect(exec).toHaveBeenCalledTimes(calls);
    }
  });

  it.each([false, true])(
    "keeps the deadline until output closes (shell exited: %s)",
    async (exited) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const killProcessTree = vi.fn();
      vi.doMock("../process/kill-tree.js", async (importOriginal) => ({
        ...(await importOriginal<typeof KillTreeModule>()),
        killProcessTree,
      }));
      const probe = await holdProbe();
      const options = { env: {}, timeoutMs: 10 };
      const pending = api.prepareShellPathFromLoginShell(options);
      Object.defineProperty(probe.child, "pid", { value: 12345 });
      if (exited) {
        await vi.advanceTimersByTimeAsync(4);
        probe.child.stdout?.emit("data", Buffer.from("\0PATH=/expired/bin\0"));
        probe.child.emit("exit", 0, null);
      }
      await vi.advanceTimersByTimeAsync(exited ? 6 : 10);
      await expect(pending).resolves.toBeNull();
      if (exited) {
        expect(killProcessTree).not.toHaveBeenCalled();
      } else {
        expect(killProcessTree).toHaveBeenCalledWith(12345, { detached: true, force: true });
      }
      expect(probe.child.stdout?.destroyed).toBe(true);
      expect(probe.child.stderr?.destroyed).toBe(true);
      await expectProbeRetry(probe, options);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps timeout and startup environment semantics and separates in-flight keys", async () => {
    const probe = await holdProbe();
    vi.spyOn(fs, "readFileSync").mockReturnValue("/bin/bash\n");
    const env = {
      SHELL: "/bin/bash",
      PATH: "/daemon/bin",
      HOME: "/ignored-home",
      ZDOTDIR: "/ignored-zdotdir",
      BASH_ENV: "/ignored-bash-env",
    };
    const first = api.prepareShellPathFromLoginShell({ env, timeoutMs: 123 });
    const options = probe.exec.mock.calls[0]?.[2];
    expect(options?.env?.HOME).toBe(os.homedir());
    expect(options?.env?.ZDOTDIR).toBeUndefined();
    expect(options?.env?.BASH_ENV).toBeUndefined();
    const finishFirst = probe.finish;
    // Settle the first child before checking a different key; its promise remains in flight.
    finishFirst(null);
    const second = api.prepareShellPathFromLoginShell({
      env,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });
    expect(second).not.toBe(first);
    expect(probe.exec.mock.calls[1]?.[2]?.timeout).toBe(MAX_TIMER_TIMEOUT_MS);
    probe.finish(null);
    await Promise.all([first, second]);
  });
});

describe("shell env fallback", () => {
  beforeEach(() => {
    mockProcessPlatform("linux");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function framedShellEnv(output: string) {
    return Buffer.from(`\0${output}`);
  }

  function runShellEnvFallback(params: Partial<Parameters<typeof api.loadShellEnvFallback>[0]>) {
    return api.loadShellEnvFallback({
      env: {},
      expectedKeys: ["OPENAI_API_KEY"],
      ...params,
    });
  }

  function expectSanitizedStartupEnv(receivedEnv: NodeJS.ProcessEnv | undefined) {
    expect(receivedEnv).toBeDefined();
    for (const key of ["BASH_ENV", "PS4", "ZDOTDIR", "SHELL"]) {
      expect(receivedEnv?.[key]).toBeUndefined();
    }
    expect(receivedEnv?.HOME).toBe(os.homedir());
  }

  function withEtcShells(shells: string[], fn: () => void) {
    const etcShellsContent = `${shells.join("\n")}\n`;
    const readFileSyncSpy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((filePath, encoding?: BufferEncoding | fs.ReadFileSyncOptions | null) => {
        if (filePath === "/etc/shells" && encoding === "utf8") {
          return etcShellsContent;
        }
        throw new Error(`Unexpected readFileSync(${String(filePath)}) in test`);
      });
    try {
      fn();
    } finally {
      readFileSyncSpy.mockRestore();
    }
  }

  it.each([
    ["OPENCLAW_LOAD_SHELL_ENV", "0", "1"],
    ["OPENCLAW_DEFER_SHELL_ENV_FALLBACK", "false", "yes"],
  ] as const)("parses the opt-in %s flag", (key, disabled, enabled) => {
    const parse =
      key === "OPENCLAW_LOAD_SHELL_ENV"
        ? api.shouldEnableShellEnvFallback
        : api.shouldDeferShellEnvFallback;
    expect(parse({})).toBe(false);
    expect(parse({ [key]: disabled })).toBe(false);
    expect(parse({ [key]: enabled })).toBe(true);
  });

  it("resolves timeout from env with default fallback", () => {
    for (const [raw, expected] of [
      [undefined, 15000],
      ["42", 42],
      ["nope", 15000],
      ["42abc", 15000],
      [String(Number.MAX_SAFE_INTEGER), MAX_TIMER_TIMEOUT_MS],
    ] as const) {
      expect(
        api.resolveShellEnvFallbackTimeoutMs(
          raw === undefined ? {} : { OPENCLAW_SHELL_ENV_TIMEOUT_MS: raw },
        ),
      ).toBe(expected);
    }
  });

  it("imports missing expected keys even when another expected key already exists", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_GATEWAY_TOKEN: "set" };
    const exec = syncExec.mockImplementation(() =>
      framedShellEnv(
        "OPENCLAW_GATEWAY_TOKEN=from-shell\0TWILIO_ACCOUNT_SID=AC123\0TWILIO_AUTH_TOKEN=secret\0TWILIO_FROM_NUMBER=+15550001234\0",
      ),
    );

    const res = runShellEnvFallback({
      env,
      expectedKeys: [
        "OPENCLAW_GATEWAY_TOKEN",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
      ],
    });

    expect(res).toEqual(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("set");
    expect(env.TWILIO_ACCOUNT_SID).toBe("AC123");
    expect(env.TWILIO_AUTH_TOKEN).toBe("secret");
    expect(env.TWILIO_FROM_NUMBER).toBe("+15550001234");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("treats explicitly empty env vars as intentional overrides", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "" };
    const exec = syncExec.mockReturnValue(framedShellEnv("OPENAI_API_KEY=from-shell\0"));

    const res = runShellEnvFallback({ env });

    expect(res).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe("");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["environment", "PATH"])("retries failed %s probes and caches recovery", (mode) => {
    const logger = { warn: vi.fn() };
    const exec = syncExec
      .mockReturnValue(framedShellEnv("OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0"))
      .mockImplementationOnce(() => {
        throw new Error(mode === "environment" ? "shell unavailable" : "exec failed");
      });
    const read = (env: NodeJS.ProcessEnv) =>
      mode === "environment"
        ? runShellEnvFallback({ env, logger })
        : api.getShellPathFromLoginShell({ env });
    expect(read({})).toEqual(mode === "environment" ? [] : null);
    for (let i = 0; i < 2; i += 1) {
      const env: NodeJS.ProcessEnv = {};
      expect(read(env)).toEqual(
        mode === "environment" ? ["OPENAI_API_KEY"] : "/usr/local/bin:/usr/bin",
      );
      if (mode === "environment") {
        expect(env.OPENAI_API_KEY).toBe("from-shell");
      }
    }
    expect(exec).toHaveBeenCalledTimes(2);
    if (mode === "environment") {
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "[openclaw] shell env fallback failed: shell unavailable",
      );
    }
  });

  it("tracks and selectively clears applied keys across success, skip, and failure", () => {
    const successEnv: NodeJS.ProcessEnv = {};
    const exec = syncExec.mockImplementation(() =>
      framedShellEnv(
        "OPENAI_API_KEY=from-shell\0ANTHROPIC_API_KEY=anthropic-shell\0DISCORD_BOT_TOKEN=\0EXTRA=ignored\0",
      ),
    );
    expect(
      runShellEnvFallback({
        env: successEnv,
        expectedKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DISCORD_BOT_TOKEN"],
      }),
    ).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(api.getShellEnvAppliedKeys()).toEqual(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    api.clearShellEnvAppliedKeys(["OPENAI_API_KEY"]);
    expect(api.getShellEnvAppliedKeys()).toEqual(["ANTHROPIC_API_KEY"]);

    expect(runShellEnvFallback({ env: successEnv })).toEqual([]);
    expect(api.getShellEnvAppliedKeys()).toStrictEqual([]);

    exec.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(
      runShellEnvFallback({
        timeoutMs: 1,
        logger: { warn: vi.fn() },
      }),
    ).toEqual([]);
    expect(api.getShellEnvAppliedKeys()).toStrictEqual([]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]?.[2]?.timeout).toBe(1);
  });

  it.each(["relative", "unregistered", "registered"])(
    "selects a trusted shell for %s SHELL",
    (kind) => {
      const trustedShell =
        hostPlatform === "win32"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : "/usr/bin/zsh-trusted";
      const requested =
        kind === "relative"
          ? "zsh"
          : kind === "unregistered"
            ? "/opt/homebrew/bin/evil-shell"
            : trustedShell;
      const exec = syncExec.mockReturnValue(framedShellEnv("OPENAI_API_KEY=from-shell\0"));
      withEtcShells(["/bin/sh", "/bin/bash", "/bin/zsh", trustedShell], () => {
        const res = runShellEnvFallback({ env: { SHELL: requested } });
        expect(res).toEqual(["OPENAI_API_KEY"]);
        expect(exec).toHaveBeenCalledTimes(1);
        expect(exec).toHaveBeenCalledWith(
          kind === "registered" ? trustedShell : "/bin/sh",
          ["-l", "-c", "printf '\\0'; env -0"],
          expect.objectContaining({ windowsHide: true }),
        );
      });
    },
  );

  it("skips shell env fallback on win32 without probing /bin/sh", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = syncExec.mockImplementation(() => {
      throw new Error("spawnSync /bin/sh ENOENT");
    });
    const logger = { warn: vi.fn() };

    mockProcessPlatform("win32");
    const res = runShellEnvFallback({ env, logger });

    expect(res).toEqual([]);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["environment", "PATH"])("sanitizes %s startup and caps its exec timeout", (mode) => {
    const env = {
      SHELL: "/bin/bash",
      HOME: "/tmp/evil-home",
      ZDOTDIR: "/tmp/evil-zdotdir",
      BASH_ENV: "/tmp/evil-bash-env",
      PS4: "$(touch /tmp/pwned)",
    };
    const exec = syncExec.mockReturnValue(
      framedShellEnv("OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0"),
    );
    const timeoutMs = Number.MAX_SAFE_INTEGER;
    if (mode === "environment") {
      expect(runShellEnvFallback({ env, timeoutMs })).toEqual(["OPENAI_API_KEY"]);
    } else {
      expect(api.getShellPathFromLoginShell({ env, timeoutMs })).toBe("/usr/local/bin:/usr/bin");
    }
    expect(exec).toHaveBeenCalledTimes(1);
    const options = exec.mock.calls[0]?.[2];
    expectSanitizedStartupEnv(options?.env);
    expect(options?.timeout).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("uses interactive Bash login startup before nounset reads PS1", () => {
    if (hostPlatform === "win32" || !fs.existsSync("/bin/bash")) {
      return;
    }
    const shell = "/bin/bash";
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const realExec = execFileSync;
    const exec = syncExec.mockImplementation((file, args, options) => {
      expect(args).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
      return realExec(file, ["-lic", "set -u; : \"$PS1\"; printf '\\0'; env -0"], options);
    });

    withEtcShells([shell], () => {
      expect(runShellEnvFallback({ env, expectedKeys: ["PATH"] })).toEqual(["PATH"]);
    });
    expect(exec).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== "linux" || !fs.existsSync("/bin/bash"))(
    "runs the login-shell probe in its own session",
    () => {
      const shell = "/bin/bash";
      const env: NodeJS.ProcessEnv = { SHELL: shell };
      const realExec = execFileSync;
      const probe = syncExec.mockImplementation((file, args, options) => {
        expect(args).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
        return realExec(
          file,
          [
            "-lic",
            'printf \'\\0OPENCLAW_PROBE_PID=%s\\0OPENCLAW_PROBE_SID=%s\\0\' "$$" "$(ps -o sid= -p $$)"; env -0',
          ],
          options,
        );
      });
      try {
        withEtcShells([shell], () => {
          expect(
            api.loadShellEnvFallback({
              env,
              expectedKeys: ["OPENCLAW_PROBE_PID", "OPENCLAW_PROBE_SID"],
            }),
          ).toEqual(["OPENCLAW_PROBE_PID", "OPENCLAW_PROBE_SID"]);
        });
        expect(env.OPENCLAW_PROBE_SID?.trim()).toBe(env.OPENCLAW_PROBE_PID);
      } finally {
        probe.mockRestore();
      }
    },
  );

  it("keeps Bash PATH discovery noninteractive and cached separately from env imports", () => {
    const shell = "/bin/bash";
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const exec = syncExec.mockImplementation(() =>
      framedShellEnv("OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0"),
    );

    withEtcShells([shell], () => {
      expect(runShellEnvFallback({ env })).toEqual(["OPENAI_API_KEY"]);
      expect(api.getShellPathFromLoginShell({ env })).toBe("/usr/local/bin:/usr/bin");
    });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]?.[1]).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
    expect(exec.mock.calls[1]?.[1]).toStrictEqual(["-l", "-c", "printf '\\0'; env -0"]);
  });

  it.each([
    ["daemon hit", "fallback", 0],
    ["daemon miss", "fallback", 1],
    ["prefer shell", "prefer", 1],
  ] as const)("resolves an executable with %s", (scenario, strategy, calls) => {
    let executable = "sh";
    let daemonBin = scenario === "daemon miss" ? "/missing" : "/bin";
    let shellBin = "/bin";
    let expectedExecutable = "/bin/sh";
    if (strategy === "prefer") {
      if (hostPlatform === "win32") {
        return;
      }
      const root = tempDirs.make("openclaw-shell-path-");
      daemonBin = path.join(root, "daemon-bin");
      shellBin = path.join(root, "shell-bin");
      fs.mkdirSync(daemonBin);
      fs.mkdirSync(shellBin);
      executable = "tool";
      fs.writeFileSync(path.join(daemonBin, executable), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      expectedExecutable = path.join(shellBin, executable);
      fs.writeFileSync(expectedExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const exec = syncExec.mockReturnValue(framedShellEnv(`PATH=${shellBin}\0`));
    const result = api.resolveExecutableFromUserShellPath(executable, {
      env: { PATH: daemonBin, SHELL: "/bin/sh" },
      strategy,
    });
    expect(result).toEqual(
      calls === 0
        ? { executable: expectedExecutable }
        : { executable: expectedExecutable, pathEnv: shellBin },
    );
    expect(exec).toHaveBeenCalledTimes(calls);
  });
});
