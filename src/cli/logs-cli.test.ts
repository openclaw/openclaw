import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withEnvAsync } from "../test-utils/env.js";
import { expectText } from "../test-utils/text-assertions.js";
import { formatCliFailureLines } from "./failure-output.js";
import {
  buildGatewayConnectionDetails,
  callGatewayFromCli,
  captureStderrWrites,
  captureStdoutWrites,
  createGatewayCloseError,
  execFileUtf8Tail,
  readConfiguredLogTail,
  readSystemdServiceRuntime,
  runLogsCli,
  useLogsCliTestHarness,
} from "./logs-cli.test-harness.js";

const readGatewayDispatchConfig = vi.fn(() => ({}));
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: () => readGatewayDispatchConfig(),
}));

function journalPage(line: string, cursor: string) {
  return { stdout: `${line}\n-- cursor: s=${cursor}`, code: 0, truncated: false };
}

const logFile = "/tmp/openclaw.log";
function logPage(lines: string[], cursor?: number, extra = {}) {
  return { file: logFile, lines, ...(cursor === undefined ? {} : { cursor }), ...extra };
}
const recoveredLine = "rpc recovered line";

async function withTty<T>(stream: NodeJS.WriteStream, action: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  try {
    return await action();
  } finally {
    if (previous) {
      Object.defineProperty(stream, "isTTY", previous);
    } else {
      Reflect.deleteProperty(stream, "isTTY");
    }
  }
}

function transientCloseError() {
  return createGatewayCloseError({
    code: 1006,
    reason: "abnormal closure",
    message: "gateway closed (1006 abnormal closure): abnormal closure",
  });
}

function expectGatewayPoll(call: number, cursor?: number, timeout?: string) {
  expect(callGatewayFromCli.mock.calls[call - 1]?.[2]).toMatchObject({ cursor });
  if (timeout !== undefined) {
    expect(callGatewayFromCli.mock.calls[call - 1]?.[1]).toMatchObject({ timeout });
  }
}

function expectJournalArgs(call: number, args: string[]) {
  expect(execFileUtf8Tail).toHaveBeenNthCalledWith(
    call,
    "journalctl",
    expect.arrayContaining(args),
    expect.any(Object),
  );
}

async function run(args: string[] = [], failure = false) {
  const stdoutWrites = captureStdoutWrites();
  const stderrWrites = captureStderrWrites();
  const exit = failure && vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  await runLogsCli(["logs", ...args]);
  if (exit) {
    expect(exit).toHaveBeenCalledWith(1);
  }
  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}
const runFailure = (args: string[]) => run(args, true);
const follow = ["--follow", "--plain", "--interval", "1"];

function useJournal() {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  readSystemdServiceRuntime.mockResolvedValue({ status: "running", pid: 2557 });
}

useLogsCliTestHarness();
beforeEach(() => {
  readGatewayDispatchConfig.mockReset().mockReturnValue({});
});

it("writes output directly to stdout/stderr", async () => {
  callGatewayFromCli.mockResolvedValueOnce(
    logPage(["raw line"], undefined, { truncated: true, reset: true }),
  );
  const { stdout, stderr } = await run();
  expectText(stdout, ["Log file:", "raw line"]);
  expectText(stderr, ["Log tail truncated (increase --limit or --max-bytes).", "Log cursor reset"]);
});

it("reports a byte-budget re-anchor without claiming rotation in JSON output", async () => {
  callGatewayFromCli.mockResolvedValueOnce(
    logPage(["line after skipped burst"], undefined, {
      truncated: true,
      reset: true,
      skippedBytes: 4096,
    }),
  );
  const { stdout, stderr } = await run(["--json"]);
  const output = `${stdout}\n${stderr}`;
  expectText(output, ["re-anchored (skipped 4096 bytes)"], ["file rotated"]);
});

it.each([
  { mode: "plain UTC", args: ["--utc", "--plain"], time: "2025-01-01T12:00:00.000Z" },
  { mode: "pretty local", args: [], time: "07:00:00-05:00" },
  { mode: "pretty UTC", args: ["--utc"], time: "12:00:00+00:00" },
])("renders $mode timestamps and preserves missing or malformed values", async ({ args, time }) => {
  await withEnvAsync({ TZ: "America/New_York" }, async () => {
    await withTty(process.stdout, async () => {
      callGatewayFromCli.mockResolvedValueOnce({
        file: "/tmp/openclaw.log",
        lines: ["2025-01-01T12:00:00.000Z", undefined, "", "invalid-date"].map((timestamp) =>
          JSON.stringify({
            time: timestamp,
            _meta: { logLevelName: "INFO", name: JSON.stringify({ subsystem: "gateway" }) },
            0: "message",
          }),
        ),
      });
      const { stdout } = await run(["--no-color", ...args]);
      expect(stdout.trim().split("\n")).toEqual([
        "Log file: /tmp/openclaw.log",
        `${time} info gateway message`,
        "info gateway message",
        "info gateway message",
        "invalid-date info gateway message",
      ]);
    });
  });
});

it("rejects combining --local-time with --utc", async () => {
  const flags = ["--local-time", "--utc"];
  const failure = await runLogsCli(["logs", ...flags]).catch((error: unknown) => error);
  expect(
    formatCliFailureLines({
      title: "The CLI command failed.",
      error: failure,
      argv: ["node", "openclaw", "logs", ...flags],
      env: {},
    }),
  ).toContain("Pass only one of --local-time or --utc.");
  expect(callGatewayFromCli).not.toHaveBeenCalled();
});

it("uses plugin identity as the text label", async () => {
  const raw = JSON.stringify({
    message: "sent",
    _meta: { name: '{"plugin":"calendar"}', logLevelName: "INFO" },
  });
  callGatewayFromCli.mockResolvedValueOnce(logPage([raw, "raw control"]));
  const { stdout } = await run(["--plain", "--no-color"]);
  expectText(stdout, ["info calendar sent\n", "raw control\n"]);
});

it("falls back to the configured local log on scope-upgrade errors", async () => {
  callGatewayFromCli.mockRejectedValueOnce(
    new Error("scope upgrade pending approval (requestId: req-123)"),
  );
  readConfiguredLogTail.mockResolvedValueOnce(logPage(["local fallback line"], 5));
  const { stdout, stderr } = await run();
  expect(stdout).toContain("local fallback line");
  expect(stderr).toContain("Local Gateway RPC unavailable");
});

it("reads local logs and warns when broken config prevents Gateway target resolution", async () => {
  readGatewayDispatchConfig.mockImplementationOnce(() => {
    throw new SyntaxError("Invalid JSON5");
  });
  buildGatewayConnectionDetails.mockImplementationOnce((options) => {
    if (options?.config === undefined) {
      throw new SyntaxError("Invalid JSON5");
    }
    return { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" };
  });
  readConfiguredLogTail.mockResolvedValueOnce(logPage(["Gateway startup failed"], 5));
  const { stdout, stderr } = await run(["--json"]);
  expect(stdout).toContain("Gateway startup failed");
  expectText(stderr, ["Configuration could not be read", "openclaw doctor --fix"]);
  expect(callGatewayFromCli).not.toHaveBeenCalled();
});

it("switches back to Gateway logs.tail after temporary journal fallback", async () => {
  useJournal();
  const recoveredPayload = logPage([recoveredLine], 10);
  const recovery = createDeferred<typeof recoveredPayload>();
  callGatewayFromCli
    .mockRejectedValueOnce(transientCloseError())
    .mockImplementationOnce(() => recovery.promise)
    .mockRejectedValueOnce(new Error("stop after delayed recovery"));
  execFileUtf8Tail
    .mockResolvedValueOnce(journalPage("journal bridge line", "abc"))
    .mockImplementationOnce(async () => {
      setTimeout(() => recovery.resolve(recoveredPayload), 0);
      return journalPage("journal while probing", "def");
    });

  const { stdout } = await runFailure([...follow, "--timeout", "250"]);
  expect(readConfiguredLogTail).not.toHaveBeenCalled();
  expectGatewayPoll(2, undefined, "250");
  expectText(stdout, [
    "journal bridge line",
    "journal while probing",
    "Log file: /tmp/openclaw.log",
    "rpc recovered line",
  ]);
});

it("keeps journal polling responsive while a Gateway recovery probe is pending", async () => {
  useJournal();
  const closeError = transientCloseError();
  callGatewayFromCli.mockRejectedValueOnce(closeError).mockImplementationOnce(
    (...args: Parameters<typeof import("./gateway-rpc.js").callGatewayFromCli>) =>
      new Promise<never>((_resolve, reject) => {
        // Model the RPC cancellation contract: final teardown joins the probe.
        const signal = args[3]?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  execFileUtf8Tail
    .mockResolvedValueOnce(journalPage("first journal line", "abc"))
    .mockResolvedValueOnce(journalPage("second journal line", "def"));

  const stdoutWrites: string[] = [];
  const stderrWrites = captureStderrWrites();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    const text = String(chunk);
    stdoutWrites.push(text);
    if (text.includes("second journal line")) {
      throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    }
    return true;
  });

  await runLogsCli(["logs", ...follow]);

  expect(stdoutWrites.join("")).toContain("second journal line");
  expectGatewayPoll(2, undefined, "30000");
  expect(readConfiguredLogTail).not.toHaveBeenCalled();
  const probeExtra = callGatewayFromCli.mock.calls[1]?.[3] as { signal?: AbortSignal };
  expect(probeExtra.signal?.aborted).toBe(true);
  expect(stderrWrites.join("")).toContain("output stdout closed");
});

it("prints source changes when Gateway RPC falls back to journal and recovers", async () => {
  useJournal();
  let tick = 0;
  vi.spyOn(Date.prototype, "toISOString").mockImplementation(
    () => `2026-06-01T00:00:0${Math.min(++tick, 8)}.000Z`,
  );
  const closeError = transientCloseError();
  callGatewayFromCli
    .mockResolvedValueOnce(logPage(["initial rpc line"], 5))
    .mockRejectedValueOnce(closeError)
    .mockResolvedValueOnce(logPage(["overlap line"], 10))
    .mockRejectedValueOnce(closeError)
    .mockRejectedValueOnce(new Error("stop after recovered cursor probe"));
  execFileUtf8Tail
    .mockResolvedValueOnce(journalPage("overlap line", "abc"))
    .mockResolvedValueOnce(journalPage("journal after recovery", "def"));

  const { stdout, stderr } = await runFailure(follow);

  expect(readConfiguredLogTail).not.toHaveBeenCalled();
  expectJournalArgs(2, ["--since=2026-06-01 00:00:03.000 UTC"]);
  const secondJournalArgs = execFileUtf8Tail.mock.calls[1]?.[1] as string[];
  expect(secondJournalArgs).not.toContain("--after-cursor=s=abc");
  expect(stdout.match(/Log file: \/tmp\/openclaw\.log/g)).toHaveLength(2);
  expectText(stdout, [
    "Log source: journalctl --user --boot --user-unit=openclaw-gateway.service _PID=2557",
    "initial rpc line",
  ]);
  expect(stdout.match(/overlap line/g)).toHaveLength(2);
  expect(stdout).toContain("journal after recovery");
  expect(stderr).toContain("reading active systemd gateway journal");
});

it("keeps journal cursor across repeated fallback before Gateway recovery", async () => {
  useJournal();
  const closeError = transientCloseError();
  callGatewayFromCli
    .mockRejectedValueOnce(closeError)
    .mockRejectedValueOnce(closeError)
    .mockResolvedValueOnce(logPage([recoveredLine], 10))
    .mockRejectedValueOnce(new Error("stop after recovered cursor probe"));
  execFileUtf8Tail
    .mockResolvedValueOnce(
      journalPage(
        "first journal bridge line Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz",
        "abc",
      ),
    )
    .mockResolvedValueOnce(journalPage("second journal bridge line", "def"));

  const { stdout, stderr } = await runFailure(follow);
  expect(readConfiguredLogTail).not.toHaveBeenCalled();
  expectJournalArgs(1, [
    "--user",
    "--boot",
    "--user-unit=openclaw-gateway.service",
    "_PID=2557",
    "--output=cat",
    "--show-cursor",
  ]);
  expectJournalArgs(2, ["--after-cursor=s=abc"]);
  expectGatewayPoll(2, undefined);
  expectGatewayPoll(3, undefined);
  expectGatewayPoll(4, 10);
  expect(stderr).toContain("reading active systemd gateway journal");
  expectText(
    stdout,
    [
      "first journal bridge line",
      "second journal bridge line",
      "rpc recovered line",
      "Log source: journalctl --user --boot --user-unit=openclaw-gateway.service _PID=2557",
      "Service PID: 2557",
      "Service Unit: openclaw-gateway.service",
      "Authorization: Bearer",
    ],
    ["sk-abcdefghijklmnopqrstuvwxyz"],
  );
});

it("retries loopback close errors in --follow mode instead of tailing fallback files", async () => {
  const closeError = transientCloseError();
  for (let i = 0; i <= 8; i += 1) {
    callGatewayFromCli.mockRejectedValueOnce(closeError);
  }

  const { stdout, stderr } = await runFailure(["--follow", "--interval", "1"]);

  expect(readConfiguredLogTail).not.toHaveBeenCalled();
  expect((stderr.match(/gateway disconnected/g) ?? []).length).toBe(8);
  expect(stderr).toContain("gateway closed (1006 abnormal closure): abnormal closure");
  expect(stdout).not.toContain("local fallback line");
});

it.each(["text", "json"])("redacts Gateway URLs in %s errors", async (mode) => {
  const rawUrl =
    "wss://user:password@gateway.example/ws?token=secret&key=api-key&X-Amz-Signature=signed";
  buildGatewayConnectionDetails.mockReturnValueOnce({
    url: rawUrl,
    urlSource: "cli --url",
    message: `Gateway target: ${rawUrl}`,
  });
  callGatewayFromCli.mockRejectedValueOnce(new Error(`failed to connect to ${rawUrl}`));

  const { stderr } = await runFailure([mode === "json" ? "--json" : "--plain", "--url", rawUrl]);

  expectText(
    stderr,
    ["failed to connect to", "gateway.example/ws"],
    ["password", "secret", "api-key", "signed"],
  );
});

it("routes terminal reset to stderr in --follow --json so stdout stays parseable JSON in a PTY", async () => {
  callGatewayFromCli.mockRejectedValueOnce(
    createGatewayCloseError({
      code: 4001,
      reason: "unauthorized",
      urlSource: "cli",
      message: "gateway closed (4001 unauthorized): unauthorized",
    }),
  );

  const { stdout, stderr } = await withTty(process.stderr, () =>
    runFailure(["--follow", "--json", "--url", "ws://127.0.0.1:18789"]),
  );

  expect(stdout).not.toContain("\x1b[");

  expect(stderr).toContain("\x1b[");
});
