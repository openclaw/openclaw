// Covers shell environment fallback loading.
import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

type ShellEnvModule = typeof import("./shell-env.js");

let clearShellEnvAppliedKeys: ShellEnvModule["clearShellEnvAppliedKeys"];
let getShellEnvAppliedKeys: ShellEnvModule["getShellEnvAppliedKeys"];
let getShellPathFromLoginShell: ShellEnvModule["getShellPathFromLoginShell"];
let prepareShellPathFromLoginShell: ShellEnvModule["prepareShellPathFromLoginShell"];
let loadShellEnvFallback: ShellEnvModule["loadShellEnvFallback"];
let resolveExecutableFromUserShellPath: ShellEnvModule["resolveExecutableFromUserShellPath"];
let resolveShellEnvFallbackTimeoutMs: ShellEnvModule["resolveShellEnvFallbackTimeoutMs"];
let shouldDeferShellEnvFallback: ShellEnvModule["shouldDeferShellEnvFallback"];
let shouldEnableShellEnvFallback: ShellEnvModule["shouldEnableShellEnvFallback"];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(async () => {
  vi.resetModules();
  ({
    clearShellEnvAppliedKeys,
    getShellEnvAppliedKeys,
    getShellPathFromLoginShell,
    prepareShellPathFromLoginShell,
    loadShellEnvFallback,
    resolveExecutableFromUserShellPath,
    resolveShellEnvFallbackTimeoutMs,
    shouldDeferShellEnvFallback,
    shouldEnableShellEnvFallback,
  } = await import("./shell-env.js"));
});

describe("async login-shell PATH preparation", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
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
    const sync = vi.fn<typeof childProcess.execFileSync>(() => {
      throw new Error("unexpected synchronous probe");
    });
    vi.doMock("node:child_process", () => ({ ...childProcess, spawn: exec, execFileSync: sync }));
    vi.resetModules();
    ({ prepareShellPathFromLoginShell, getShellPathFromLoginShell } =
      await import("./shell-env.js"));
    return {
      exec,
      sync,
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

  it("shares an in-flight probe and makes later synchronous resolution immediate", async () => {
    const probe = await holdProbe();
    const options = { env: { PATH: "/daemon/bin" }, platform: "linux" as const };
    const first = prepareShellPathFromLoginShell(options);
    const second = prepareShellPathFromLoginShell(options);
    expect(second).toBe(first);
    expect(probe.exec).toHaveBeenCalledOnce();
    probe.finish(null, "startup banner\n\0PATH= /shell/bin \0BAD\0");
    await expect(first).resolves.toBe("/shell/bin");
    expect(getShellPathFromLoginShell(options)).toBe("/shell/bin");
    await expect(prepareShellPathFromLoginShell(options)).resolves.toBe("/shell/bin");
    expect(probe.sync).not.toHaveBeenCalled();
    expect(probe.exec).toHaveBeenCalledOnce();
  });

  it.each([new Error("ENOENT"), Object.assign(new Error("timed out"), { killed: true })])(
    "retries failed preparation without caching the failure (%s)",
    async (error) => {
      const probe = await holdProbe();
      const options = { env: {}, platform: "linux" as const };
      const first = prepareShellPathFromLoginShell(options);
      probe.finish(error);
      await expect(first).resolves.toBeNull();
      const retry = prepareShellPathFromLoginShell(options);
      expect(probe.exec).toHaveBeenCalledTimes(2);
      probe.finish(null);
      await expect(retry).resolves.toBe("/shell/bin");
      expect(getShellPathFromLoginShell(options)).toBe("/shell/bin");
      expect(probe.sync).not.toHaveBeenCalled();
    },
  );

  it("preserves a synchronous result published during preparation", async () => {
    const probe = await holdProbe();
    const options = { env: {}, platform: "linux" as const };
    const pending = prepareShellPathFromLoginShell(options);
    probe.sync.mockReturnValue(Buffer.from("\0PATH=/sync/bin\0"));
    expect(getShellPathFromLoginShell(options)).toBe("/sync/bin");
    expect(probe.exec.mock.calls[0]).toEqual(probe.sync.mock.calls[0]);
    expect(probe.exec.mock.calls[0]?.[2]).toMatchObject({
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    probe.finish(null);
    await expect(pending).resolves.toBe("/sync/bin");
    expect(getShellPathFromLoginShell(options)).toBe("/sync/bin");
  });

  it.each(["timeout", "stdout overflow", "stderr overflow", "combined output overflow"])(
    "does not cache a %s even when the shell exits zero",
    async (failure) => {
      const probe = await holdProbe();
      const options = { env: {}, platform: "linux" as const };
      const pending = prepareShellPathFromLoginShell(options);
      if (failure === "timeout") {
        Object.defineProperty(probe.child, "killed", { value: true });
      } else {
        if (failure === "combined output overflow") {
          probe.child.stdout?.emit("data", Buffer.alloc(1024 * 1024));
          probe.child.stderr?.emit("data", Buffer.alloc(1024 * 1024 + 1));
        } else {
          const stream = failure === "stdout overflow" ? probe.child.stdout : probe.child.stderr;
          stream?.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1));
        }
        expect(probe.kill).toHaveBeenCalledOnce();
      }
      probe.finish(null);
      expect(probe.child.stdout?.destroyed).toBe(true);
      expect(probe.child.stderr?.destroyed).toBe(true);
      await expect(pending).resolves.toBeNull();
      const retry = prepareShellPathFromLoginShell(options);
      expect(probe.exec).toHaveBeenCalledTimes(2);
      probe.finish(null);
      await expect(retry).resolves.toBe("/shell/bin");
    },
  );

  it.each(["\0PATH= \0", "unframed PATH=/shell/bin"])(
    "caches successful output with no usable PATH (%s)",
    async (output) => {
      const probe = await holdProbe();
      const options = { env: {}, platform: "linux" as const };
      const pending = prepareShellPathFromLoginShell(options);
      probe.finish(null, output);
      await expect(pending).resolves.toBeNull();
      expect(getShellPathFromLoginShell(options)).toBeNull();
      expect(probe.sync).not.toHaveBeenCalled();
    },
  );

  it("keeps the deadline through descendant-held output pipes after shell exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const probe = await holdProbe();
    const options = { env: {}, timeoutMs: 10, platform: "linux" as const };
    const pending = prepareShellPathFromLoginShell(options);
    await vi.advanceTimersByTimeAsync(4);
    probe.child.stdout?.emit("data", Buffer.from("\0PATH=/expired/bin\0"));
    probe.child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(6);
    expect(probe.child.stdout?.destroyed).toBe(true);
    expect(probe.child.stderr?.destroyed).toBe(true);
    await expect(pending).resolves.toBeNull();
    const retry = prepareShellPathFromLoginShell(options);
    expect(probe.exec).toHaveBeenCalledTimes(2);
    probe.finish(null);
    await expect(retry).resolves.toBe("/shell/bin");
    expect(vi.getTimerCount()).toBe(0);
  });

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
    const first = prepareShellPathFromLoginShell({ env, timeoutMs: 123, platform: "linux" });
    expect(probe.exec).toHaveBeenCalledWith(
      "/bin/bash",
      ["-l", "-c", "printf '\\0'; env -0"],
      expect.objectContaining({
        encoding: "buffer",
        timeout: 123,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      }),
    );
    const options = probe.exec.mock.calls[0]?.[2];
    expect(options?.env?.HOME).toBe(os.homedir());
    expect(options?.env?.ZDOTDIR).toBeUndefined();
    expect(options?.env?.BASH_ENV).toBeUndefined();
    const finishFirst = probe.finish;
    // Settle the first child before checking a different key; its promise remains in flight.
    finishFirst(null);
    const second = prepareShellPathFromLoginShell({
      env,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      platform: "linux",
    });
    expect(second).not.toBe(first);
    expect(probe.exec.mock.calls[1]?.[2]?.timeout).toBe(MAX_TIMER_TIMEOUT_MS);
    probe.finish(null);
    await Promise.all([first, second]);
  });

  it("falls back to /bin/sh for an untrusted shell", async () => {
    const probe = await holdProbe();
    const pending = prepareShellPathFromLoginShell({
      env: { SHELL: "relative-shell" },
      platform: "linux",
    });
    expect(probe.exec.mock.calls[0]?.[0]).toBe("/bin/sh");
    probe.finish(null);
    await pending;
  });

  it("returns null on Windows without starting a shell", async () => {
    const probe = await holdProbe();
    const options = { env: {}, platform: "win32" as const };
    await expect(prepareShellPathFromLoginShell(options)).resolves.toBeNull();
    expect(getShellPathFromLoginShell(options)).toBeNull();
    expect(probe.exec).not.toHaveBeenCalled();
    expect(probe.sync).not.toHaveBeenCalled();
  });
});

describe("shell env fallback", () => {
  function framedShellEnv(output: string): Buffer {
    return Buffer.from(`\0${output}`);
  }

  function probeShellPathWithFreshCache(params: {
    exec: ReturnType<typeof vi.fn>;
    platform: NodeJS.Platform;
  }) {
    const exec = params.exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"];
    const first = getShellPathFromLoginShell({
      env: {} as NodeJS.ProcessEnv,
      exec,
      platform: params.platform,
    });
    const second = getShellPathFromLoginShell({
      env: {} as NodeJS.ProcessEnv,
      exec,
      platform: params.platform,
    });
    return { first, second };
  }

  function runShellEnvFallbackForShell(shell: string) {
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const exec = vi.fn(() => framedShellEnv("OPENAI_API_KEY=from-shell\0"));
    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec,
    });
    return { res, exec };
  }

  function runShellEnvFallback(params: {
    enabled: boolean;
    env: NodeJS.ProcessEnv;
    expectedKeys: string[];
    exec: ReturnType<typeof vi.fn>;
    logger?: Pick<typeof console, "warn">;
    platform?: NodeJS.Platform;
  }) {
    return loadShellEnvFallback({
      enabled: params.enabled,
      env: params.env,
      expectedKeys: params.expectedKeys,
      exec: params.exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      logger: params.logger,
      platform: params.platform,
    });
  }

  function makeUnsafeStartupEnv(): NodeJS.ProcessEnv {
    return {
      SHELL: "/bin/bash",
      HOME: "/tmp/evil-home",
      ZDOTDIR: "/tmp/evil-zdotdir",
      BASH_ENV: "/tmp/evil-bash-env",
      PS4: "$(touch /tmp/pwned)",
    };
  }

  function expectSanitizedStartupEnv(receivedEnv: NodeJS.ProcessEnv | undefined) {
    if (receivedEnv === undefined) {
      throw new Error("expected sanitized startup env");
    }
    expect(receivedEnv.BASH_ENV).toBeUndefined();
    expect(receivedEnv.PS4).toBeUndefined();
    expect(receivedEnv.ZDOTDIR).toBeUndefined();
    expect(receivedEnv.SHELL).toBeUndefined();
    expect(receivedEnv.HOME).toBe(os.homedir());
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

  function requireExecCall(exec: ReturnType<typeof vi.fn>, index = 0): unknown[] {
    const call = (exec.mock.calls as unknown[][])[index];
    if (!call) {
      throw new Error("expected shell env exec call");
    }
    return call;
  }

  function expectBinShFallbackExec(exec: ReturnType<typeof vi.fn>) {
    expect(exec).toHaveBeenCalledTimes(1);
    const [shell, args, options] = requireExecCall(exec);
    expect(shell).toBe("/bin/sh");
    expect(args).toStrictEqual(["-l", "-c", "printf '\\0'; env -0"]);
    expect((options as { windowsHide?: unknown } | undefined)?.windowsHide).toBe(true);
  }

  it("is disabled by default", () => {
    expect(shouldEnableShellEnvFallback({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldEnableShellEnvFallback({ OPENCLAW_LOAD_SHELL_ENV: "0" })).toBe(false);
    expect(shouldEnableShellEnvFallback({ OPENCLAW_LOAD_SHELL_ENV: "1" })).toBe(true);
  });

  it("uses the same truthy env parsing for deferred fallback", () => {
    expect(shouldDeferShellEnvFallback({} as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldDeferShellEnvFallback({ OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "false" })).toBe(false);
    expect(shouldDeferShellEnvFallback({ OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "yes" })).toBe(true);
  });

  it("resolves timeout from env with default fallback", () => {
    expect(resolveShellEnvFallbackTimeoutMs({} as NodeJS.ProcessEnv)).toBe(15000);
    expect(resolveShellEnvFallbackTimeoutMs({ OPENCLAW_SHELL_ENV_TIMEOUT_MS: "42" })).toBe(42);
    expect(
      resolveShellEnvFallbackTimeoutMs({
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: "nope",
      }),
    ).toBe(15000);
    expect(
      resolveShellEnvFallbackTimeoutMs({
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: "42abc",
      }),
    ).toBe(15000);
    expect(
      resolveShellEnvFallbackTimeoutMs({
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      }),
    ).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("caps oversized fallback exec timeouts before probing the login shell", () => {
    const env: NodeJS.ProcessEnv = {};
    let receivedTimeout: number | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { timeout?: number }) => {
      receivedTimeout = options.timeout;
      return framedShellEnv("OPENAI_API_KEY=from-shell\0");
    });

    const res = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      timeoutMs: Number.MAX_SAFE_INTEGER,
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    expect(res.ok).toBe(true);
    expect(receivedTimeout).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("imports missing expected keys even when another expected key already exists", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_GATEWAY_TOKEN: "set" };
    const exec = vi.fn(() =>
      framedShellEnv(
        "OPENCLAW_GATEWAY_TOKEN=from-shell\0TWILIO_ACCOUNT_SID=AC123\0TWILIO_AUTH_TOKEN=secret\0TWILIO_FROM_NUMBER=+15550001234\0",
      ),
    );

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: [
        "OPENCLAW_GATEWAY_TOKEN",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
      ],
      exec,
    });

    expect(res).toEqual({
      ok: true,
      applied: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    });
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBe("set");
    expect(env.TWILIO_ACCOUNT_SID).toBe("AC123");
    expect(env.TWILIO_AUTH_TOKEN).toBe("secret");
    expect(env.TWILIO_FROM_NUMBER).toBe("+15550001234");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("treats explicitly empty env vars as intentional overrides", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "" };
    const exec = vi.fn(() => framedShellEnv("OPENAI_API_KEY=from-shell\0"));

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec,
    });

    expect(res.ok).toBe(true);
    expect(res.applied).toStrictEqual([]);
    expect(res.ok && res.skippedReason).toBe("already-has-keys");
    expect(env.OPENAI_API_KEY).toBe("");
    expect(exec).not.toHaveBeenCalled();
  });

  it("retries failed login-shell env probes and caches the recovered environment", () => {
    const logger = { warn: vi.fn() };
    const exec = vi
      .fn(() => framedShellEnv("OPENAI_API_KEY=from-shell\0"))
      .mockImplementationOnce(() => {
        throw new Error("shell unavailable");
      });

    expect(
      runShellEnvFallback({
        enabled: true,
        env: {},
        expectedKeys: ["OPENAI_API_KEY"],
        exec,
        logger,
      }),
    ).toEqual({ ok: false, applied: [], error: "shell unavailable" });

    for (let i = 0; i < 2; i += 1) {
      const env: NodeJS.ProcessEnv = {};
      expect(
        runShellEnvFallback({
          enabled: true,
          env,
          expectedKeys: ["OPENAI_API_KEY"],
          exec,
          logger,
        }),
      ).toEqual({ ok: true, applied: ["OPENAI_API_KEY"] });
      expect(env.OPENAI_API_KEY).toBe("from-shell");
    }

    expect(exec).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "successful",
      oldest: framedShellEnv("PROBE_RESULT=oldest\0"),
      newest: framedShellEnv("PROBE_RESULT=newest\0"),
      refreshOldest: false,
    },
    {
      name: "recent successful",
      oldest: framedShellEnv("PROBE_RESULT=oldest\0"),
      newest: framedShellEnv("PROBE_RESULT=newest\0"),
      refreshOldest: true,
    },
  ])("bounds $name probe entries with LRU eviction", ({ oldest, newest, refreshOldest }) => {
    const logger = { warn: vi.fn() };
    const makeExec = (outcome: Buffer) => vi.fn(() => outcome);
    const runProbe = (exec: ReturnType<typeof vi.fn>) =>
      runShellEnvFallback({
        enabled: true,
        env: {},
        expectedKeys: ["PROBE_RESULT"],
        exec,
        logger,
      });
    const oldestExec = makeExec(oldest);
    const oldestFillerExec = makeExec(framedShellEnv("PROBE_RESULT=filler-0\0"));
    const fillerExecs = [
      oldestFillerExec,
      ...Array.from({ length: 62 }, (_, index) =>
        makeExec(framedShellEnv(`PROBE_RESULT=filler-${index + 1}\0`)),
      ),
    ];
    const newestExec = makeExec(newest);

    for (const exec of [oldestExec, ...fillerExecs]) {
      runProbe(exec);
    }
    if (refreshOldest) {
      runProbe(oldestExec);
    }
    runProbe(newestExec);
    runProbe(newestExec);
    runProbe(oldestExec);

    expect(newestExec).toHaveBeenCalledOnce();
    expect(oldestExec).toHaveBeenCalledTimes(refreshOldest ? 1 : 2);
    if (refreshOldest) {
      runProbe(oldestFillerExec);
      expect(oldestFillerExec).toHaveBeenCalledTimes(2);
    }
  });

  it("tracks last applied keys across success, skip, and failure paths", () => {
    const successEnv: NodeJS.ProcessEnv = {};
    const successExec = vi.fn(() =>
      framedShellEnv("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=\0EXTRA=ignored\0"),
    );
    expect(
      loadShellEnvFallback({
        enabled: true,
        env: successEnv,
        expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
        exec: successExec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({
      ok: true,
      applied: ["OPENAI_API_KEY"],
    });
    expect(getShellEnvAppliedKeys()).toEqual(["OPENAI_API_KEY"]);

    expect(
      loadShellEnvFallback({
        enabled: false,
        env: {},
        expectedKeys: ["OPENAI_API_KEY"],
        exec: successExec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({
      ok: true,
      applied: [],
      skippedReason: "disabled",
    });
    expect(getShellEnvAppliedKeys()).toStrictEqual([]);

    const failureExec = vi.fn(() => {
      throw new Error("boom");
    });
    expect(
      loadShellEnvFallback({
        enabled: true,
        env: {},
        expectedKeys: ["OPENAI_API_KEY"],
        exec: failureExec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
        logger: { warn: vi.fn() },
      }),
    ).toEqual({
      ok: false,
      applied: [],
      error: "boom",
    });
    expect(getShellEnvAppliedKeys()).toStrictEqual([]);
  });

  it("clears only discarded shell-applied keys", () => {
    loadShellEnvFallback({
      enabled: true,
      env: {},
      expectedKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      exec: (() =>
        framedShellEnv(
          "OPENAI_API_KEY=openai-shell\0ANTHROPIC_API_KEY=anthropic-shell\0",
        )) as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
    });

    clearShellEnvAppliedKeys(["OPENAI_API_KEY"]);

    expect(getShellEnvAppliedKeys()).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("retries failed login-shell PATH reads and caches the recovered path", () => {
    const exec = vi
      .fn(() => framedShellEnv("PATH=/usr/local/bin:/usr/bin\0"))
      .mockImplementationOnce(() => {
        throw new Error("exec failed");
      });

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "linux",
    });

    expect(first).toBeNull();
    expect(second).toBe("/usr/local/bin:/usr/bin");
    expect(
      getShellPathFromLoginShell({
        env: {},
        exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
        platform: "linux",
      }),
    ).toBe(second);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("returns null when login shell PATH is blank", () => {
    const exec = vi.fn(() => framedShellEnv("PATH=   \0HOME=/tmp\0"));

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "linux",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("falls back to /bin/sh when SHELL is non-absolute", () => {
    const { res, exec } = runShellEnvFallbackForShell("zsh");

    expect(res.ok).toBe(true);
    expectBinShFallbackExec(exec);
  });

  it("falls back to /bin/sh when SHELL is absolute but not registered in /etc/shells", () => {
    withEtcShells(["/bin/sh", "/bin/bash", "/bin/zsh"], () => {
      const { res, exec } = runShellEnvFallbackForShell("/opt/homebrew/bin/evil-shell");

      expect(res.ok).toBe(true);
      expectBinShFallbackExec(exec);
    });
  });

  it("uses SHELL when it is explicitly registered in /etc/shells", () => {
    const trustedShell =
      process.platform === "win32"
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : "/usr/bin/zsh-trusted";
    withEtcShells(["/bin/sh", trustedShell], () => {
      const { res, exec } = runShellEnvFallbackForShell(trustedShell);

      expect(res.ok).toBe(true);
      expect(exec).toHaveBeenCalledTimes(1);
      const [shell, args, options] = requireExecCall(exec);
      expect(shell).toBe(trustedShell);
      expect(args).toStrictEqual(["-l", "-c", "printf '\\0'; env -0"]);
      expect((options as { windowsHide?: unknown } | undefined)?.windowsHide).toBe(true);
    });
  });

  it("skips shell env fallback on win32 without probing /bin/sh", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn(() => {
      throw new Error("spawnSync /bin/sh ENOENT");
    });
    const logger = { warn: vi.fn() };

    const res = loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      logger,
      platform: "win32",
    });

    expect(res).toEqual({ ok: true, applied: [] });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sanitizes startup-related env vars before shell fallback exec", () => {
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnv = options.env;
      return framedShellEnv("OPENAI_API_KEY=from-shell\0");
    });

    const res = runShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: ["OPENAI_API_KEY"],
      exec,
    });

    expect(res.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
  });

  it("ignores startup output before the framed environment payload", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn((_shell: string, args: string[]) => {
      const frame = args.at(-1) === "printf '\\0'; env -0" ? "\0" : "";
      return Buffer.from(`NOTICE=startup output\n${frame}OPENAI_API_KEY=from-shell\0`);
    });

    expect(
      loadShellEnvFallback({
        enabled: true,
        env,
        expectedKeys: ["OPENAI_API_KEY"],
        exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      }),
    ).toEqual({ ok: true, applied: ["OPENAI_API_KEY"] });
    expect(env.OPENAI_API_KEY).toBe("from-shell");
  });

  it("uses interactive Bash login startup before nounset reads PS1", () => {
    if (process.platform === "win32" || !fs.existsSync("/bin/bash")) {
      return;
    }
    const shell = "/bin/bash";
    const env: NodeJS.ProcessEnv = { SHELL: shell };
    const exec = vi.fn(
      (file: string, args: string[], options: Parameters<typeof execFileSync>[2]) => {
        expect(args).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
        return execFileSync(file, ["-lic", "set -u; : \"$PS1\"; printf '\\0'; env -0"], options);
      },
    );

    withEtcShells([shell], () => {
      expect(
        loadShellEnvFallback({
          enabled: true,
          env,
          expectedKeys: ["PATH"],
          exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
        }),
      ).toMatchObject({ ok: true });
    });
    expect(exec).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== "linux" || !fs.existsSync("/bin/bash"))(
    "runs the login-shell probe in its own session",
    () => {
      const shell = "/bin/bash";
      const env: NodeJS.ProcessEnv = { SHELL: shell };
      const realExec = execFileSync;
      const probe = vi
        .spyOn(childProcess, "execFileSync")
        .mockImplementation((file, args, options) => {
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
            loadShellEnvFallback({
              enabled: true,
              env,
              expectedKeys: ["OPENCLAW_PROBE_PID", "OPENCLAW_PROBE_SID"],
              exec: childProcess.execFileSync,
            }),
          ).toEqual({ ok: true, applied: ["OPENCLAW_PROBE_PID", "OPENCLAW_PROBE_SID"] });
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
    const exec = vi.fn(() =>
      framedShellEnv("OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0"),
    );

    withEtcShells([shell], () => {
      expect(
        loadShellEnvFallback({
          enabled: true,
          env,
          expectedKeys: ["OPENAI_API_KEY"],
          exec: exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
        }),
      ).toEqual({ ok: true, applied: ["OPENAI_API_KEY"] });
      expect(
        getShellPathFromLoginShell({
          env,
          exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
          platform: "linux",
        }),
      ).toBe("/usr/local/bin:/usr/bin");
    });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(requireExecCall(exec)[1]).toStrictEqual(["-lic", "printf '\\0'; env -0"]);
    expect(requireExecCall(exec, 1)[1]).toStrictEqual(["-l", "-c", "printf '\\0'; env -0"]);
  });

  it("sanitizes startup-related env vars before login-shell PATH probe", () => {
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    const exec = vi.fn((_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      receivedEnv = options.env;
      return framedShellEnv("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0");
    });

    const result = getShellPathFromLoginShell({
      env,
      exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      platform: "linux",
    });

    expect(result).toBe("/usr/local/bin:/usr/bin");
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
  });

  it("resolves from the daemon PATH without probing the login shell", () => {
    const exec = vi.fn(() => framedShellEnv("PATH=/bin\0"));

    const result = resolveExecutableFromUserShellPath("sh", {
      env: { PATH: "/bin" },
      strategy: "fallback",
      exec: exec as unknown as Parameters<typeof resolveExecutableFromUserShellPath>[1]["exec"],
    });

    expect(result).toEqual({ executable: "/bin/sh" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves from the login-shell PATH when the daemon PATH misses the executable", () => {
    const exec = vi.fn(() => framedShellEnv("PATH=/bin\0"));

    const result = resolveExecutableFromUserShellPath("sh", {
      env: { PATH: "/missing", SHELL: "/bin/sh" },
      strategy: "fallback",
      exec: exec as unknown as Parameters<typeof resolveExecutableFromUserShellPath>[1]["exec"],
    });

    expect(result).toEqual({ executable: "/bin/sh", pathEnv: "/bin" });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("prefers the login-shell executable over a daemon PATH candidate when requested", () => {
    if (process.platform === "win32") {
      return;
    }
    const root = tempDirs.make("openclaw-shell-path-");
    const daemonBin = path.join(root, "daemon-bin");
    const shellBin = path.join(root, "shell-bin");
    fs.mkdirSync(daemonBin);
    fs.mkdirSync(shellBin);
    const daemonTool = path.join(daemonBin, "tool");
    const shellTool = path.join(shellBin, "tool");
    fs.writeFileSync(daemonTool, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(shellTool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const exec = vi.fn(() => framedShellEnv(`PATH=${shellBin}\0`));

    const result = resolveExecutableFromUserShellPath("tool", {
      env: { PATH: daemonBin, SHELL: "/bin/sh" },
      strategy: "prefer",
      exec: exec as unknown as Parameters<typeof resolveExecutableFromUserShellPath>[1]["exec"],
    });

    expect(result).toEqual({ executable: shellTool, pathEnv: shellBin });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns null without invoking shell on win32", () => {
    const exec = vi.fn(() => framedShellEnv("PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0"));

    const { first, second } = probeShellPathWithFreshCache({
      exec,
      platform: "win32",
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});
