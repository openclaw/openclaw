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
    const options = {
      env: { PATH: "/daemon/bin", SHELL: "relative-shell" },
      platform: "linux" as const,
    };
    const first = prepareShellPathFromLoginShell(options);
    const second = prepareShellPathFromLoginShell(options);
    expect(second).toBe(first);
    expect(probe.exec).toHaveBeenCalledOnce();
    expect(probe.exec.mock.calls[0]?.[0]).toBe("/bin/sh");
    probe.finish(null, "startup banner\n\0PATH= /shell/bin \0BAD\0");
    await expect(first).resolves.toBe("/shell/bin");
    expect(getShellPathFromLoginShell(options)).toBe("/shell/bin");
    await expect(prepareShellPathFromLoginShell(options)).resolves.toBe("/shell/bin");
    expect(probe.sync).not.toHaveBeenCalled();
    expect(probe.exec).toHaveBeenCalledOnce();
  });

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

  it.each(["spawn error", "timeout", "stdout overflow", "combined output overflow"])(
    "retries %s without caching the failed preparation",
    async (failure) => {
      const probe = await holdProbe();
      const options = { env: {}, platform: "linux" as const };
      const pending = prepareShellPathFromLoginShell(options);
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
      const retry = prepareShellPathFromLoginShell(options);
      expect(probe.exec).toHaveBeenCalledTimes(2);
      probe.finish(null);
      await expect(retry).resolves.toBe("/shell/bin");
      expect(getShellPathFromLoginShell(options)).toBe("/shell/bin");
      expect(probe.sync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["async", "linux", "\0PATH= \0", 1],
    ["async", "linux", "unframed PATH=/shell/bin", 1],
    ["async", "win32", "\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0", 0],
    ["sync", "linux", "\0PATH=   \0HOME=/tmp\0", 1],
    ["sync", "win32", "\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0", 0],
  ] as const)("caches a null %s PATH on %s for %j", async (mode, platform, output, calls) => {
    if (mode === "async") {
      const probe = await holdProbe();
      const options = { env: {}, platform };
      const pending = prepareShellPathFromLoginShell(options);
      if (calls > 0) {
        probe.finish(null, output);
      }
      await expect(pending).resolves.toBeNull();
      expect(getShellPathFromLoginShell(options)).toBeNull();
      expect(probe.exec).toHaveBeenCalledTimes(calls);
      expect(probe.sync).not.toHaveBeenCalled();
    } else {
      const exec = vi.fn(() => Buffer.from(output));
      const options = {
        env: {},
        platform,
        exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
      };
      expect(getShellPathFromLoginShell(options)).toBeNull();
      expect(getShellPathFromLoginShell(options)).toBeNull();
      expect(exec).toHaveBeenCalledTimes(calls);
    }
  });

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
});

describe("shell env fallback", () => {
  function framedShellEnv(output: string): Buffer {
    return Buffer.from(`\0${output}`);
  }

  function runShellEnvFallback(params: {
    enabled?: boolean;
    env?: NodeJS.ProcessEnv;
    expectedKeys?: string[];
    exec: ReturnType<typeof vi.fn>;
    logger?: Pick<typeof console, "warn">;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
  }) {
    return loadShellEnvFallback({
      enabled: params.enabled ?? true,
      env: params.env ?? {},
      expectedKeys: params.expectedKeys ?? ["OPENAI_API_KEY"],
      exec: params.exec as unknown as Parameters<typeof loadShellEnvFallback>[0]["exec"],
      logger: params.logger,
      platform: params.platform,
      timeoutMs: params.timeoutMs,
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

  it.each([
    ["OPENCLAW_LOAD_SHELL_ENV", "0", "1"],
    ["OPENCLAW_DEFER_SHELL_ENV_FALLBACK", "false", "yes"],
  ] as const)("parses the opt-in %s flag", (key, disabled, enabled) => {
    const parse =
      key === "OPENCLAW_LOAD_SHELL_ENV"
        ? shouldEnableShellEnvFallback
        : shouldDeferShellEnvFallback;
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
        resolveShellEnvFallbackTimeoutMs(
          raw === undefined ? {} : { OPENCLAW_SHELL_ENV_TIMEOUT_MS: raw },
        ),
      ).toBe(expected);
    }
  });

  it("imports missing expected keys even when another expected key already exists", () => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_GATEWAY_TOKEN: "set" };
    const exec = vi.fn(() =>
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

    const res = runShellEnvFallback({ env, exec });

    expect(res.ok).toBe(true);
    expect(res.applied).toStrictEqual([]);
    expect(res.ok && res.skippedReason).toBe("already-has-keys");
    expect(env.OPENAI_API_KEY).toBe("");
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["environment", "PATH"])("retries failed %s probes and caches recovery", (mode) => {
    const logger = { warn: vi.fn() };
    const exec = vi
      .fn(() => framedShellEnv("OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0"))
      .mockImplementationOnce(() => {
        throw new Error(mode === "environment" ? "shell unavailable" : "exec failed");
      });
    const read = (env: NodeJS.ProcessEnv) =>
      mode === "environment"
        ? runShellEnvFallback({ env, exec, logger })
        : getShellPathFromLoginShell({
            env,
            exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
            platform: "linux",
          });
    expect(read({})).toEqual(
      mode === "environment" ? { ok: false, applied: [], error: "shell unavailable" } : null,
    );
    for (let i = 0; i < 2; i += 1) {
      const env: NodeJS.ProcessEnv = {};
      expect(read(env)).toEqual(
        mode === "environment"
          ? { ok: true, applied: ["OPENAI_API_KEY"] }
          : "/usr/local/bin:/usr/bin",
      );
      if (mode === "environment") {
        expect(env.OPENAI_API_KEY).toBe("from-shell");
      }
    }
    expect(exec).toHaveBeenCalledTimes(2);
    if (mode === "environment") {
      expect(logger.warn).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])(
    "bounds successful probe entries with LRU eviction (refresh: %s)",
    (refreshOldest) => {
      const logger = { warn: vi.fn() };
      const makeExec = (value: string) => vi.fn(() => framedShellEnv(`PROBE_RESULT=${value}\0`));
      const runProbe = (exec: ReturnType<typeof vi.fn>) =>
        runShellEnvFallback({ expectedKeys: ["PROBE_RESULT"], exec, logger });
      const oldestExec = makeExec("oldest");
      const oldestFillerExec = makeExec("filler-0");
      const fillerExecs = [
        oldestFillerExec,
        ...Array.from({ length: 62 }, (_, i) => makeExec(`filler-${i + 1}`)),
      ];
      const newestExec = makeExec("newest");

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
    },
  );

  it("tracks last applied keys across success, skip, and failure paths", () => {
    const successEnv: NodeJS.ProcessEnv = {};
    const successExec = vi.fn(() =>
      framedShellEnv("OPENAI_API_KEY=from-shell\0DISCORD_BOT_TOKEN=\0EXTRA=ignored\0"),
    );
    expect(
      runShellEnvFallback({
        env: successEnv,
        expectedKeys: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
        exec: successExec,
      }),
    ).toEqual({
      ok: true,
      applied: ["OPENAI_API_KEY"],
    });
    expect(getShellEnvAppliedKeys()).toEqual(["OPENAI_API_KEY"]);

    expect(runShellEnvFallback({ enabled: false, exec: successExec })).toEqual({
      ok: true,
      applied: [],
      skippedReason: "disabled",
    });
    expect(getShellEnvAppliedKeys()).toStrictEqual([]);

    const failureExec = vi.fn(() => {
      throw new Error("boom");
    });
    expect(
      runShellEnvFallback({
        exec: failureExec,
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
    runShellEnvFallback({
      expectedKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      exec: vi.fn(() =>
        framedShellEnv("OPENAI_API_KEY=openai-shell\0ANTHROPIC_API_KEY=anthropic-shell\0"),
      ),
    });

    clearShellEnvAppliedKeys(["OPENAI_API_KEY"]);

    expect(getShellEnvAppliedKeys()).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it.each(["relative", "unregistered", "registered"])(
    "selects a trusted shell for %s SHELL",
    (kind) => {
      const trustedShell =
        process.platform === "win32"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : "/usr/bin/zsh-trusted";
      const requested =
        kind === "relative"
          ? "zsh"
          : kind === "unregistered"
            ? "/opt/homebrew/bin/evil-shell"
            : trustedShell;
      const exec = vi.fn(() => framedShellEnv("OPENAI_API_KEY=from-shell\0"));
      withEtcShells(["/bin/sh", "/bin/bash", "/bin/zsh", trustedShell], () => {
        const res = runShellEnvFallback({ env: { SHELL: requested }, exec });
        expect(res.ok).toBe(true);
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
    const exec = vi.fn(() => {
      throw new Error("spawnSync /bin/sh ENOENT");
    });
    const logger = { warn: vi.fn() };

    const res = runShellEnvFallback({ env, exec, logger, platform: "win32" });

    expect(res).toEqual({ ok: true, applied: [] });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["environment", "PATH"])("sanitizes %s startup and caps its exec timeout", (mode) => {
    const env = makeUnsafeStartupEnv();
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    let receivedTimeout: number | undefined;
    const exec = vi.fn(
      (_shell: string, _args: string[], options: { env: NodeJS.ProcessEnv; timeout?: number }) => {
        receivedEnv = options.env;
        receivedTimeout = options.timeout;
        return framedShellEnv(
          "OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0HOME=/tmp\0",
        );
      },
    );
    const timeoutMs = Number.MAX_SAFE_INTEGER;
    if (mode === "environment") {
      expect(runShellEnvFallback({ env, exec, timeoutMs }).ok).toBe(true);
    } else {
      expect(
        getShellPathFromLoginShell({
          env,
          exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
          platform: "linux",
          timeoutMs,
        }),
      ).toBe("/usr/local/bin:/usr/bin");
    }
    expect(exec).toHaveBeenCalledTimes(1);
    expectSanitizedStartupEnv(receivedEnv);
    expect(receivedTimeout).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores startup output before the framed environment payload", () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = vi.fn((_shell: string, args: string[]) => {
      const frame = args.at(-1) === "printf '\\0'; env -0" ? "\0" : "";
      return Buffer.from(`NOTICE=startup output\n${frame}OPENAI_API_KEY=from-shell\0`);
    });

    expect(runShellEnvFallback({ env, exec })).toEqual({ ok: true, applied: ["OPENAI_API_KEY"] });
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
      expect(runShellEnvFallback({ env, expectedKeys: ["PATH"], exec })).toMatchObject({
        ok: true,
      });
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
    const exec = vi.fn((_shell: string, _args: string[]) =>
      framedShellEnv("OPENAI_API_KEY=from-shell\0PATH=/usr/local/bin:/usr/bin\0"),
    );

    withEtcShells([shell], () => {
      expect(runShellEnvFallback({ env, exec })).toEqual({ ok: true, applied: ["OPENAI_API_KEY"] });
      expect(
        getShellPathFromLoginShell({
          env,
          exec: exec as unknown as Parameters<typeof getShellPathFromLoginShell>[0]["exec"],
          platform: "linux",
        }),
      ).toBe("/usr/local/bin:/usr/bin");
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
      if (process.platform === "win32") {
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
    const exec = vi.fn(() => framedShellEnv(`PATH=${shellBin}\0`));
    const result = resolveExecutableFromUserShellPath(executable, {
      env: { PATH: daemonBin, SHELL: "/bin/sh" },
      strategy,
      exec: exec as unknown as Parameters<typeof resolveExecutableFromUserShellPath>[1]["exec"],
    });
    expect(result).toEqual(
      calls === 0
        ? { executable: expectedExecutable }
        : { executable: expectedExecutable, pathEnv: shellBin },
    );
    expect(exec).toHaveBeenCalledTimes(calls);
  });
});
