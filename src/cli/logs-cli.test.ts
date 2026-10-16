import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
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
  return { stdout: `${line}\n-- cursor: s=${cursor}`, stderr: "", code: 0, truncated: false };
}

function transientCloseError() {
  return createGatewayCloseError({
    code: 1006,
    reason: "abnormal closure",
    message: "gateway closed (1006 abnormal closure): abnormal closure",
  });
}

function expectGatewayPoll(call: number, cursor?: number, timeout = "30000") {
  expect(callGatewayFromCli).toHaveBeenNthCalledWith(
    call,
    "logs.tail",
    expect.objectContaining({ timeout }),
    { cursor, limit: 200, maxBytes: 250_000 },
    expect.any(Object),
  );
}

function expectJournalArgs(call: number, args: string[]) {
  expect(execFileUtf8Tail).toHaveBeenNthCalledWith(
    call,
    "journalctl",
    expect.arrayContaining(args),
    expect.any(Object),
  );
}

function expectRecoveryCalls(gateway: number, journal: number) {
  expect(readConfiguredLogTail).not.toHaveBeenCalled();
  expect(callGatewayFromCli).toHaveBeenCalledTimes(gateway);
  expect(execFileUtf8Tail).toHaveBeenCalledTimes(journal);
}

function expectText(text: string, includes: string[], excludes: string[] = []) {
  for (const value of includes) {
    expect(text).toContain(value);
  }
  for (const value of excludes) {
    expect(text).not.toContain(value);
  }
}

const captureOutput = () => ({
  stdoutWrites: captureStdoutWrites(),
  stderrWrites: captureStderrWrites(),
});

function useJournal() {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  readSystemdServiceRuntime.mockResolvedValue({ status: "running", pid: 2557 });
}

describe("logs cli", () => {
  useLogsCliTestHarness();
  beforeEach(() => {
    readGatewayDispatchConfig.mockReset().mockReturnValue({});
  });

  it("writes output directly to stdout/stderr", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      size: 123,
      lines: ["raw line"],
      truncated: true,
      reset: true,
    });

    const { stdoutWrites, stderrWrites } = captureOutput();

    await runLogsCli(["logs"]);

    expectText(stdoutWrites.join(""), ["Log file:", "raw line"]);
    expectText(stderrWrites.join(""), [
      "Log tail truncated (increase --limit or --max-bytes).",
      "Log cursor reset",
    ]);
  });

  it("reports a byte-budget re-anchor without claiming rotation in JSON output", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 8192,
      size: 8192,
      lines: ["line after skipped burst"],
      truncated: true,
      reset: true,
      skippedBytes: 4096,
    });

    const { stdoutWrites, stderrWrites } = captureOutput();

    await runLogsCli(["logs", "--json"]);

    const output = `${stdoutWrites.join("")}\n${stderrWrites.join("")}`;
    expectText(output, ["re-anchored (skipped 4096 bytes)"], ["file rotated"]);
  });

  it.each([
    { mode: "plain UTC", tty: true, args: ["--utc", "--plain"], time: "2025-01-01T12:00:00.000Z" },
    { mode: "pretty local", tty: true, args: [], time: "07:00:00-05:00" },
    { mode: "pretty UTC", tty: true, args: ["--utc"], time: "12:00:00+00:00" },
  ])(
    "renders $mode timestamps and preserves missing or malformed values",
    async ({ tty, args, time }) => {
      await withEnvAsync({ TZ: "America/New_York" }, async () => {
        const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
        try {
          callGatewayFromCli.mockResolvedValueOnce({
            file: "/tmp/openclaw.log",
            lines: [
              { time: "2025-01-01T12:00:00.000Z", message: "valid timestamp" },
              { message: "missing timestamp" },
              { time: "", message: "empty timestamp" },
              { time: "invalid-date", message: "invalid timestamp" },
              { time: "not-a-date", message: "other invalid timestamp" },
            ].map((entry) =>
              JSON.stringify({
                time: entry.time,
                _meta: { logLevelName: "INFO", name: JSON.stringify({ subsystem: "gateway" }) },
                0: entry.message,
              }),
            ),
          });
          const stdoutWrites = captureStdoutWrites();

          await runLogsCli(["logs", "--no-color", ...args]);

          expect(stdoutWrites.join("").trim().split("\n")).toEqual([
            "Log file: /tmp/openclaw.log",
            `${time} info gateway valid timestamp`,
            "info gateway missing timestamp",
            "info gateway empty timestamp",
            "invalid-date info gateway invalid timestamp",
            "not-a-date info gateway other invalid timestamp",
          ]);
        } finally {
          if (stdoutTty) {
            Object.defineProperty(process.stdout, "isTTY", stdoutTty);
          } else {
            Reflect.deleteProperty(process.stdout, "isTTY");
          }
        }
      });
    },
  );

  it("retains calendar log identity in text and JSON", async () => {
    const context = { plugin: "calendar" };
    const raw = JSON.stringify({
      message: "sent",
      _meta: { name: JSON.stringify(context), logLevelName: "INFO" },
    });
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: [raw, "raw control"],
    });
    const writes = captureStdoutWrites();
    await runLogsCli(["logs", "--plain", "--no-color"]);
    expectText(writes.join(""), ["info calendar sent\n", "raw control\n"]);
    writes.length = 0;
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: [raw, "raw control"],
    });
    await runLogsCli(["logs", "--json"]);
    const records = writes
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({ type: "log", ...context, message: "sent", raw }),
    );
    expect(records).toContainEqual({ type: "raw", raw: "raw control" });
  });

  it("falls back to the configured local log on scope-upgrade errors", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      new Error("scope upgrade pending approval (requestId: req-123)"),
    );
    readConfiguredLogTail.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 5,
      size: 5,
      lines: ["local fallback line"],
      truncated: false,
      reset: false,
    });
    const { stdoutWrites, stderrWrites } = captureOutput();

    await runLogsCli(["logs"]);

    expect(readConfiguredLogTail).toHaveBeenCalledExactlyOnceWith({
      cursor: undefined,
      limit: 200,
      maxBytes: 250_000,
    });
    expect(stdoutWrites.join("")).toContain("local fallback line");
    expect(stderrWrites.join("")).toContain("Local Gateway RPC unavailable");
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
    readConfiguredLogTail.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 5,
      size: 5,
      lines: ["Gateway startup failed"],
      truncated: false,
      reset: false,
    });
    const { stdoutWrites, stderrWrites } = captureOutput();

    await runLogsCli(["logs", "--json"]);

    expect(stdoutWrites.join("")).toContain("Gateway startup failed");
    expectText(stderrWrites.join(""), ["Configuration could not be read", "openclaw doctor --fix"]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  describe("--follow retry behavior", () => {
    it("uses the active systemd journal for implicit local follow failures", async () => {
      useJournal();
      const closeError = transientCloseError();
      callGatewayFromCli.mockRejectedValueOnce(closeError).mockRejectedValueOnce(closeError);
      execFileUtf8Tail
        .mockResolvedValueOnce(
          journalPage("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz", "abc"),
        )
        .mockResolvedValueOnce(journalPage("second journal line", "def"));

      const { stdoutWrites, stderrWrites } = captureOutput();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--interval", "1"]);

      expect(readConfiguredLogTail).not.toHaveBeenCalled();
      expect(execFileUtf8Tail).toHaveBeenCalledWith(
        "journalctl",
        expect.arrayContaining([
          "--user",
          "--boot",
          "--user-unit=openclaw-gateway.service",
          "_PID=2557",
          "--output=cat",
          "--show-cursor",
        ]),
        expect.any(Object),
      );
      expectJournalArgs(2, ["--after-cursor=s=abc"]);
      expect(stderrWrites.join("")).toContain("reading active systemd gateway journal");
      expectText(
        stdoutWrites.join(""),
        [
          "Log source: journalctl --user --boot --user-unit=openclaw-gateway.service _PID=2557",
          "Service PID: 2557",
          "Service Unit: openclaw-gateway.service",
          "Authorization: Bearer",
          "second journal line",
        ],
        ["sk-abcdefghijklmnopqrstuvwxyz"],
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("switches back to Gateway logs.tail after temporary journal fallback", async () => {
      useJournal();
      const recoveredPayload = {
        file: "/tmp/openclaw.log",
        cursor: 10,
        lines: [
          JSON.stringify({
            time: "2026-05-29T20:00:00.000Z",
            _meta: { logLevelName: "INFO", name: "gateway" },
            0: "rpc recovered line",
          }),
        ],
      };
      let resolveRecovery!: (payload: typeof recoveredPayload) => void;
      const recoveryProbe = new Promise<typeof recoveredPayload>((resolve) => {
        resolveRecovery = resolve;
      });
      callGatewayFromCli
        .mockRejectedValueOnce(transientCloseError())
        .mockImplementationOnce(() => recoveryProbe)
        .mockRejectedValueOnce(new Error("stop after delayed recovery"));
      execFileUtf8Tail
        .mockResolvedValueOnce(journalPage("journal bridge line", "abc"))
        .mockImplementationOnce(async () => {
          setTimeout(() => resolveRecovery(recoveredPayload), 0);
          return journalPage("journal while probing", "def");
        });

      const stdoutWrites = captureStdoutWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      // Pin UTC: the recovered-line assertion below checks a rendered
      // timestamp, which otherwise follows the host time zone.
      await withEnvAsync({ TZ: "UTC" }, () =>
        runLogsCli(["logs", "--follow", "--plain", "--interval", "1", "--timeout", "250"]),
      );

      expectRecoveryCalls(3, 2);
      expectGatewayPoll(2, undefined, "250");
      const output = stdoutWrites.join("");
      expectText(output, [
        "journal bridge line",
        "journal while probing",
        "Log file: /tmp/openclaw.log",
        "rpc recovered line",
        "2026-05-29T20:00:00.000",
      ]);
      expect(exitSpy).toHaveBeenCalledWith(1);
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
          const error = new Error("EPIPE") as NodeJS.ErrnoException;
          error.code = "EPIPE";
          throw error;
        }
        return true;
      });

      await runLogsCli(["logs", "--follow", "--plain", "--interval", "1"]);

      expect(stdoutWrites.join("")).toContain("second journal line");
      expectGatewayPoll(2, undefined, "30000");
      expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
      expect(execFileUtf8Tail).toHaveBeenCalledTimes(2);
      const probeExtra = callGatewayFromCli.mock.calls[1]?.[3] as { signal?: AbortSignal };
      expect(probeExtra.signal?.aborted).toBe(true);
      expect(stderrWrites.join("")).toContain("output stdout closed");
    });

    it("prints source changes when Gateway RPC falls back to journal and recovers", async () => {
      useJournal();
      const timestamps = [
        "2026-06-01T00:00:01.000Z",
        "2026-06-01T00:00:02.000Z",
        "2026-06-01T00:00:03.000Z",
        "2026-06-01T00:00:04.000Z",
        "2026-06-01T00:00:05.000Z",
        "2026-06-01T00:00:06.000Z",
        "2026-06-01T00:00:07.000Z",
      ];
      vi.spyOn(Date.prototype, "toISOString").mockImplementation(
        () => timestamps.shift() ?? "2026-06-01T00:00:08.000Z",
      );
      const closeError = transientCloseError();
      callGatewayFromCli
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 5,
          lines: ["initial rpc line"],
        })
        .mockRejectedValueOnce(closeError)
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 10,
          lines: ["overlap line"],
        })
        .mockRejectedValueOnce(closeError)
        .mockRejectedValueOnce(new Error("stop after recovered cursor probe"));
      execFileUtf8Tail
        .mockResolvedValueOnce(journalPage("overlap line", "abc"))
        .mockResolvedValueOnce(journalPage("journal after recovery", "def"));

      const { stdoutWrites, stderrWrites } = captureOutput();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--plain", "--interval", "1"]);

      expectRecoveryCalls(5, 2);
      expectJournalArgs(2, ["--since=2026-06-01 00:00:03.000 UTC"]);
      const secondJournalArgs = execFileUtf8Tail.mock.calls[1]?.[1] as string[];
      expect(secondJournalArgs).not.toContain("--after-cursor=s=abc");
      const output = stdoutWrites.join("");
      expect(output.match(/Log file: \/tmp\/openclaw\.log/g)).toHaveLength(2);
      expectText(output, [
        "Log source: journalctl --user --boot --user-unit=openclaw-gateway.service _PID=2557",
        "initial rpc line",
      ]);
      expect(output.match(/overlap line/g)).toHaveLength(2);
      expect(output).toContain("journal after recovery");
      expect(stderrWrites.join("")).toContain("reading active systemd gateway journal");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("keeps journal cursor across repeated fallback before Gateway recovery", async () => {
      useJournal();
      const closeError = transientCloseError();
      callGatewayFromCli
        .mockRejectedValueOnce(closeError)
        .mockRejectedValueOnce(closeError)
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 10,
          lines: [
            JSON.stringify({
              time: "2026-05-29T20:00:00.000Z",
              _meta: { logLevelName: "INFO", name: "gateway" },
              0: "rpc recovered line",
            }),
          ],
        })
        .mockRejectedValueOnce(new Error("stop after recovered cursor probe"));
      execFileUtf8Tail
        .mockResolvedValueOnce(journalPage("first journal bridge line", "abc"))
        .mockResolvedValueOnce(journalPage("second journal bridge line", "def"));

      const stdoutWrites = captureStdoutWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--plain", "--interval", "1"]);

      expect(readConfiguredLogTail).not.toHaveBeenCalled();
      expect(execFileUtf8Tail).toHaveBeenCalledTimes(2);
      expectJournalArgs(2, ["--after-cursor=s=abc"]);
      expect(callGatewayFromCli).toHaveBeenCalledTimes(4);
      expect(callGatewayFromCli).toHaveBeenNthCalledWith(
        2,
        "logs.tail",
        expect.any(Object),
        { cursor: undefined, limit: 200, maxBytes: 250_000 },
        expect.any(Object),
      );
      expect(callGatewayFromCli).toHaveBeenNthCalledWith(
        3,
        "logs.tail",
        expect.any(Object),
        { cursor: undefined, limit: 200, maxBytes: 250_000 },
        expect.any(Object),
      );
      expect(callGatewayFromCli).toHaveBeenNthCalledWith(
        4,
        "logs.tail",
        expect.any(Object),
        { cursor: 10, limit: 200, maxBytes: 250_000 },
        expect.any(Object),
      );
      const output = stdoutWrites.join("");
      expectText(output, [
        "first journal bridge line",
        "second journal bridge line",
        "rpc recovered line",
      ]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("retries loopback close errors in --follow mode instead of tailing fallback files", async () => {
      const closeError = transientCloseError();
      for (let i = 0; i <= 8; i += 1) {
        callGatewayFromCli.mockRejectedValueOnce(closeError);
      }

      const { stdoutWrites, stderrWrites } = captureOutput();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", "--follow", "--interval", "1"]);

      expect(readConfiguredLogTail).not.toHaveBeenCalled();
      expect((stderrWrites.join("").match(/gateway disconnected/g) ?? []).length).toBe(8);
      expect(stderrWrites.join("")).toContain(
        "gateway closed (1006 abnormal closure): abnormal closure",
      );
      expect(stdoutWrites.join("")).not.toContain("local fallback line");
      expect(exitSpy).toHaveBeenCalledWith(1);
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
      const stderrWrites = captureStderrWrites();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      await runLogsCli(["logs", mode === "json" ? "--json" : "--plain", "--url", rawUrl]);

      const stderr = stderrWrites.join("");
      expectText(
        stderr,
        ["failed to connect to", "gateway.example/ws"],
        ["password", "secret", "api-key", "signed"],
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
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

      const { stdoutWrites, stderrWrites } = captureOutput();
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      // Simulate PTY: stderr is a TTY so the terminal reset fires and gets
      // routed to stderr instead of stdout. Object.defineProperty is needed
      // because isTTY is an inherited getter not reachable via vi.spyOn.
      const prevDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
      Object.defineProperty(process.stderr, "isTTY", {
        get: () => true,
        configurable: true,
      });
      try {
        await runLogsCli(["logs", "--follow", "--json", "--url", "ws://127.0.0.1:18789"]);
      } finally {
        if (prevDescriptor) {
          Object.defineProperty(process.stderr, "isTTY", prevDescriptor);
        } else {
          delete (process.stderr as unknown as Record<string, unknown>).isTTY;
        }
      }

      // stdout must contain only parseable JSON — no ANSI escape bytes
      const stdout = stdoutWrites.join("");
      expect(stdout).not.toContain("\x1b[");

      // stderr receives the terminal reset instead of stdout
      const stderr = stderrWrites.join("");
      expect(stderr).toContain("\x1b[");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
