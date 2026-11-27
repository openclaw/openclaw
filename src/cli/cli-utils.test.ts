import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitError } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { registerDnsCli } from "./dns-cli.js";
import {
  formatCliFailureLines,
  formatCliJsonFailure,
  recordCliGatewayRunFailure,
} from "./failure-output.js";
import {
  applyResolvedCommandOutputMode,
  withConsoleLogsRoutedToStderrForJson,
} from "./json-output-mode.js";
import { parseByteSize } from "./parse-bytes.js";
import { parseDurationMs } from "./parse-duration.js";
import { shouldSkipStartupEnvironmentRespawnForArgv } from "./respawn-policy.js";
import { waitForever } from "./wait.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const rejectWith = (error: Error) => () => Promise.reject(error);

it("waitForever keeps the event loop alive with a ref'd interval and pending promise", () => {
  const unref = vi.fn();
  const interval = { unref } as unknown as ReturnType<typeof setInterval>;
  const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
  const promise = waitForever();
  expect(setIntervalSpy.mock.calls).toEqual([[expect.any(Function), 1_000_000]]);
  // An unref'd interval exited with code 13 (unsettled top-level await).
  expect(unref).not.toHaveBeenCalled();
  expect(promise).toBeInstanceOf(Promise);
});

describe("runCommandWithRuntime", () => {
  it("preserves completed exit 2 with a custom error handler", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn() };
    const onError = vi.fn();
    const outcome = new ExitError(2);

    await expect(runCommandWithRuntime(runtime, rejectWith(outcome), onError)).rejects.toBe(
      outcome,
    );

    expect([runtime.error, runtime.exit, onError].flatMap((mock) => mock.mock.calls)).toEqual([]);
  });

  it("keeps cause chains and error codes behind debug intent", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn() };
    const cause = Object.assign(new Error("invalid hook"), { code: "UND_ERR_INVALID_ARG" });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause });

    vi.stubEnv("OPENCLAW_DEBUG", undefined);
    await runCommandWithRuntime(runtime, rejectWith(fetchError));
    vi.stubEnv("OPENCLAW_DEBUG", "1");
    await runCommandWithRuntime(runtime, rejectWith(fetchError));

    expect(runtime.error.mock.calls).toEqual([
      ["fetch failed"],
      ["fetch failed | invalid hook | UND_ERR_INVALID_ARG"],
    ]);
    expect(runtime.exit.mock.calls).toEqual([[1], [1]]);
  });

  it("reports JSON failures once while retaining the original envelope", async () => {
    const runtime = { error: vi.fn(), exit: vi.fn() };
    const error = new Error("archive missing");
    recordCliGatewayRunFailure(error, "run-1");
    await withConsoleLogsRoutedToStderrForJson(["--json"], async () => {
      applyResolvedCommandOutputMode(true);
      const caught = await runCommandWithRuntime(runtime, rejectWith(error)).catch(
        (err: unknown) => err,
      );
      expect(formatCliJsonFailure(caught)).toEqual({
        ok: false,
        runId: "run-1",
        origin: "gateway",
        error: { type: "cli_error", message: "archive missing" },
      });
      expect(formatCliFailureLines({ title: "failed", error: caught })).toEqual([]);
    });
    expect(runtime.error.mock.calls).toEqual([["archive missing"]]);
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});

it.each([
  [["--help"], undefined, true],
  [["tui"], undefined, false],
  [["hooks", "relay", "--relay-id", "relay-1"], undefined, true],
  [["hooks", "relay", "--relay-id", "relay-1"], "win32", false],
  [["gateway"], undefined, true],
  [["gateway", "run", "--port=14720", "--bind", "loopback"], undefined, true],
  [["gateway", "status"], undefined, false],
  [["--", "gateway", "run"], undefined, true],
  [["--profile", "server", "gateway", "run", "--allow-unconfigured"], undefined, true],
  [["status"], undefined, false],
  [["gateway", "call", "health"], undefined, false],
  [["--", "gateway", "run", "--force"], undefined, false],
] as const)("resolves the startup respawn policy for %j on %s", (args, platform, startup) => {
  expect(shouldSkipStartupEnvironmentRespawnForArgv(["node", "openclaw", ...args], platform)).toBe(
    startup,
  );
});

it.each(["../../x", "evil\nrecords"])(
  "rejects invalid --domain %j with explicit DNS-name diagnostic",
  async (domain) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerDnsCli(program);
    await expect(
      program.parseAsync(["dns", "setup", "--domain", domain], { from: "user" }),
    ).rejects.toThrow("wide-area discovery domain must be a valid DNS name");
    expect(log).not.toHaveBeenCalled();
  },
);

it.each([
  [parseByteSize, "10kb", 10 * 1024],
  [parseByteSize, `${Number.MAX_SAFE_INTEGER}.1`, Number.MAX_SAFE_INTEGER],
  [parseDurationMs, "0.5s", 500],
  [parseDurationMs, "2.0235s", 2024],
  [parseDurationMs, "2023.5ms", 2024],
  [parseDurationMs, "2s23.49999999999999999ms", 2023],
  [parseDurationMs, "9007199254740990ms0.25ms0.25ms", Number.MAX_SAFE_INTEGER],
  [parseDurationMs, "  1H30M  ", 5_400_000],
  [parseDurationMs, "0.4ms0.4ms", 1],
  [parseDurationMs, "9007199254740990ms1ms", Number.MAX_SAFE_INTEGER],
] as const)("%s parses %j", (parse, input, expected) => {
  expect(parse(input)).toBe(expected);
});

it.each([
  [parseByteSize, "", /Invalid byte size/],
  [parseByteSize, "nope", /Invalid byte size/],
  [parseByteSize, "9007199254740993", /Invalid byte size/],
  [parseDurationMs, "", /Invalid duration/],
  [parseDurationMs, "-1s", /Invalid duration/],
  [parseDurationMs, "1h30", /Invalid duration/],
  [parseDurationMs, "9007199254740990ms10ms", /Invalid duration/],
] as const)("%s rejects %j", (parse, input, error) => {
  expect(() => parse(input)).toThrow(error);
});

it("retains the 100-character duration limit per token, including the default unit", () => {
  const value = `${"0".repeat(97)}1`;
  expect(parseDurationMs(`${value}ms`)).toBe(1);
  expect(parseDurationMs(value)).toBe(1);
  expect(parseDurationMs(`0${value}`, { defaultUnit: "s" })).toBe(1000);
  expect(parseDurationMs("1ms".repeat(40))).toBe(40);
  expect(() => parseDurationMs(`0${value}ms`)).toThrow(/Invalid duration/);
  expect(() => parseDurationMs(`0${value}`)).toThrow(/Invalid duration/);
  expect(() => parseDurationMs(`1s0${value}ms`)).toThrow(/Invalid duration/);
});
