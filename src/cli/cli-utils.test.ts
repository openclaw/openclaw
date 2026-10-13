// CLI utility tests cover shared command helpers, option parsing, and output formatting.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { defaultRuntime, ExitError } from "../runtime.js";
import { captureEnv } from "../test-utils/env.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { registerDnsCli } from "./dns-cli.js";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "./json-output-mode.js";
import { parseByteSize } from "./parse-bytes.js";
import { parseDurationMs } from "./parse-duration.js";
import {
  shouldSkipRespawnForArgv,
  shouldSkipStartupEnvironmentRespawnForArgv,
} from "./respawn-policy.js";
import { waitForever } from "./wait.js";

describe("waitForever", () => {
  it("keeps the event loop alive (ref'd interval) and returns a pending promise", () => {
    const unref = vi.fn();
    const interval = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    try {
      const promise = waitForever();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const [callback, delay] = setIntervalSpy.mock.calls[0] ?? [];
      expect(typeof callback).toBe("function");
      expect(delay).toBe(1_000_000);
      // Regression guard for the previous `.unref()` bug: an unref'd interval
      // does NOT keep the event loop alive, so `await waitForever()` would
      // exit immediately with code 13 ("unsettled top-level await"). The
      // function must NOT unref the interval.
      expect(unref).not.toHaveBeenCalled();
      expect(promise).toBeInstanceOf(Promise);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

describe("runCommandWithRuntime", () => {
  it.each([
    { code: 0, customErrorHandler: false },
    { code: 2, customErrorHandler: true },
  ])(
    "preserves completed exit $code with custom error handler $customErrorHandler",
    async ({ code, customErrorHandler }) => {
      const runtime = { error: vi.fn(), exit: vi.fn() };
      const onError = vi.fn();
      const outcome = new ExitError(code);

      await expect(
        runCommandWithRuntime(
          runtime,
          async () => {
            throw outcome;
          },
          customErrorHandler ? onError : undefined,
        ),
      ).rejects.toBe(outcome);

      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("keeps cause chains and error codes behind debug intent", async () => {
    const messages: string[] = [];
    const exits: number[] = [];
    const cause = Object.assign(new Error("invalid onRequestStart method"), {
      code: "UND_ERR_INVALID_ARG",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause });

    const run = async () =>
      await runCommandWithRuntime(
        {
          error: (message) => messages.push(message),
          exit: (code) => exits.push(code),
        },
        async () => {
          throw fetchError;
        },
      );

    const originalEnv = captureEnv(["OPENCLAW_DEBUG"]);
    delete process.env.OPENCLAW_DEBUG;
    try {
      await run();
      process.env.OPENCLAW_DEBUG = "1";
      await run();
    } finally {
      originalEnv.restore();
    }

    expect(messages).toEqual([
      "fetch failed",
      "fetch failed | invalid onRequestStart method | UND_ERR_INVALID_ARG",
    ]);
    expect(exits).toEqual([1, 1]);
  });

  it("bubbles JSON-mode failures to the process-level owner", async () => {
    const originalArgv = process.argv;
    const runtime = { error: vi.fn(), exit: vi.fn() };
    process.argv = ["node", "openclaw", "backup", "verify", "missing.tgz", "--json"];
    try {
      await withConsoleLogsRoutedToStderrForJson(process.argv, async () => {
        applyResolvedCommandOutputMode(true);
        await expect(
          runCommandWithRuntime(runtime, async () => {
            throw new Error("archive missing");
          }),
        ).rejects.toThrow("archive missing");
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});

describe("respawn policy", () => {
  it.each([
    { args: ["--help"], skip: true, startup: true },
    { args: ["-V"], skip: true, startup: true },
    { args: ["tui"], skip: true, startup: false },
    { args: ["hooks", "relay", "--relay-id", "relay-1"], skip: true, startup: true },
    {
      args: ["hooks", "relay", "--relay-id", "relay-1"],
      platform: "win32",
      skip: false,
      startup: false,
    },
    { args: ["gateway"], skip: true, startup: true },
    { args: ["gateway", "--port", "14720", "--bind", "loopback"], skip: true, startup: true },
    { args: ["gateway", "run", "--port=14720", "--bind", "loopback"], skip: true, startup: true },
    { args: ["gateway", "--update-canary"], skip: true, startup: true },
    { args: ["gateway", "run", "--update-canary", "--port=14720"], skip: true, startup: true },
    { args: ["gateway", "status"], skip: true, startup: false },
    { args: ["--", "gateway", "run"], skip: true, startup: true },
    { args: ["gateway", "--", "status"], skip: true, startup: false },
    { args: ["gateway", "--token", "test-token", "status"], skip: true, startup: false },
    {
      args: ["--profile", "server", "gateway", "run", "--allow-unconfigured"],
      skip: true,
      startup: true,
    },
    { args: ["--profile", "server", "gateway", "status", "--json"], skip: true, startup: false },
    { args: ["status"], skip: false, startup: false },
    { args: ["gateway", "call", "health"], skip: false, startup: false },
    { args: ["--", "gateway", "run", "--force"], skip: false, startup: false },
  ] satisfies { args: string[]; platform?: NodeJS.Platform; skip: boolean; startup: boolean }[])(
    "resolves both respawn policies for $args on $platform",
    ({ args, platform, skip, startup }) => {
      const argv = ["node", "openclaw", ...args];
      expect(shouldSkipRespawnForArgv(argv, platform), argv.join(" ")).toBe(skip);
      expect(shouldSkipStartupEnvironmentRespawnForArgv(argv, platform), argv.join(" ")).toBe(
        startup,
      );
    },
  );
});

describe("dns cli", () => {
  it("prints setup info (no apply)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    try {
      const program = new Command();
      registerDnsCli(program);
      await program.parseAsync(["dns", "setup", "--domain", "openclaw.internal"], { from: "user" });
      const output = log.mock.calls.map((call) => call.join(" ")).join("\\n");
      expect(output).toContain("DNS setup");
      expect(output).toContain("openclaw.internal");
      expect(writeJson).toHaveBeenCalledWith({
        gateway: { bind: "auto" },
        discovery: { wideArea: { domain: "openclaw.internal." } },
      });
    } finally {
      writeJson.mockRestore();
      log.mockRestore();
    }
  });

  it.each(["../../x", "evil\nrecords"])(
    "rejects invalid --domain %j with explicit DNS-name diagnostic",
    async (domain) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const program = new Command();
        registerDnsCli(program);
        await expect(
          program.parseAsync(["dns", "setup", "--domain", domain], { from: "user" }),
        ).rejects.toThrow("wide-area discovery domain must be a valid DNS name");
        const output = log.mock.calls.map((call) => call.join(" ")).join("\\n");
        expect(output).not.toContain("No wide-area domain configured");
        expect(output).not.toContain("DNS setup");
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("parseByteSize", () => {
  it.each([
    ["10kb", 10 * 1024],
    ["123", 123],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    [`${Number.MAX_SAFE_INTEGER}.1`, Number.MAX_SAFE_INTEGER],
  ] as const)("parses %s without losing precision", (input, expected) => {
    expect(parseByteSize(input)).toBe(expected);
  });

  it.each(["", "nope", "9007199254740993"])("rejects invalid byte size %j", (input) => {
    expect(() => parseByteSize(input)).toThrow(/Invalid byte size/);
  });
});

describe("parseDurationMs", () => {
  it.each([
    ["10000", 10_000],
    ["0.5s", 500],
    ["  1H30M  ", 5_400_000],
    ["0.4ms0.4ms", 1],
    ["30m1h30m", 7_200_000],
    ["9007199254740991ms", Number.MAX_SAFE_INTEGER],
    ["9007199254740990ms1ms", Number.MAX_SAFE_INTEGER],
  ] as const)("parses %s", (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it("uses the default unit only for bare numbers", () => {
    expect(parseDurationMs("1.5", { defaultUnit: "m" })).toBe(90_000);
    expect(parseDurationMs("1s", { defaultUnit: "m" })).toBe(1000);
  });

  it.each(["", "-1s", "1w", "1h30", "9007199254740993ms", "9007199254740990ms10ms"])(
    "rejects invalid or unsafe duration %j",
    (input) => {
      expect(() => parseDurationMs(input)).toThrow(/Invalid duration/);
    },
  );

  it("retains the 100-character limit per token, including the default unit", () => {
    const value = `${"0".repeat(97)}1`;
    expect(parseDurationMs(`${value}ms`)).toBe(1);
    expect(parseDurationMs(value)).toBe(1);
    expect(parseDurationMs(`0${value}`, { defaultUnit: "s" })).toBe(1000);
    expect(parseDurationMs("1ms".repeat(40))).toBe(40);
    expect(() => parseDurationMs(`0${value}ms`)).toThrow(/Invalid duration/);
    expect(() => parseDurationMs(`0${value}`)).toThrow(/Invalid duration/);
    expect(() => parseDurationMs(`1s0${value}ms`)).toThrow(/Invalid duration/);
  });
});
