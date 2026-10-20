import { describe, expect, it, vi } from "vitest";
import {
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

const mocks = vi.hoisted(() => ({
  delay: vi.fn(async () => {}),
  readConfig: vi.fn(() => ({})),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
// mock-isolation: Exercise unreadable config without reading the operator's configuration.
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: mocks.readConfig,
}));

describe("logs cli follow across Gateway log-file changes", () => {
  useLogsCliTestHarness();

  it.each([
    { mode: "plain", bridge: false, failReread: false },
    { mode: "json", bridge: false, failReread: false },
    { mode: "json", bridge: true, failReread: false },
    { mode: "plain", bridge: false, failReread: true },
    { mode: "plain", bridge: false, failReread: false, local: true },
  ])(
    "reads the complete new file in $mode mode (journal: $bridge, failed reread: $failReread)",
    async ({ mode, bridge, failReread, local = false }) => {
      const closeError = createGatewayCloseError({
        code: 1006,
        reason: "abnormal closure",
        message: "gateway closed (1006 abnormal closure): abnormal closure",
      });
      const readLogs = local ? readConfiguredLogTail : callGatewayFromCli;
      if (local) {
        mocks.readConfig.mockImplementationOnce(() => {
          throw new SyntaxError("Invalid JSON5");
        });
        callGatewayFromCli.mockRejectedValue(new Error("unauthorized"));
      }
      readLogs.mockResolvedValueOnce({
        file: "/tmp/old.log",
        cursor: 10,
        lines: ["old file line"],
      });
      if (bridge) {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        callGatewayFromCli.mockRejectedValueOnce(closeError);
        readSystemdServiceRuntime.mockResolvedValue({ status: "running", pid: 2557 });
        execFileUtf8Tail.mockResolvedValueOnce({
          stdout: "journal bridge line\n-- cursor: s=bridge",
          stderr: "",
          code: 0,
          truncated: false,
        });
      }
      let failedReread = false;
      const nextFile = async ({ cursor }: { cursor?: number }) => {
        if (cursor === 50) {
          throw new Error("stop after appended line");
        }
        if (cursor === undefined && failReread && !failedReread) {
          failedReread = true;
          throw closeError;
        }
        return {
          file: "/tmp/new.log",
          cursor: cursor === 40 ? 50 : 40,
          lines:
            cursor === 40
              ? ["appended line"]
              : cursor === undefined
                ? ["new first line", "new last line"]
                : ["new last line"],
        };
      };
      if (local) {
        readConfiguredLogTail.mockImplementation(nextFile);
      } else {
        callGatewayFromCli.mockImplementation(
          async (_method, _options, params: { cursor?: number }) => nextFile(params),
        );
      }
      const stdoutWrites = captureStdoutWrites();
      captureStderrWrites();
      vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      try {
        await runLogsCli(["logs", "--follow", `--${mode}`]);
        const lines = stdoutWrites.join("").trim().split("\n");
        const messages =
          mode === "json"
            ? lines
                .map((line) => JSON.parse(line) as { type: string; raw?: string })
                .filter((record) => record.type === "raw")
                .map((record) => record.raw)
            : lines.filter((line) => !line.startsWith("Log file:"));
        expect(messages).toEqual([
          "old file line",
          ...(bridge ? ["journal bridge line"] : []),
          "new first line",
          "new last line",
          "appended line",
        ]);
        expect(failedReread).toBe(failReread);
        if (local) {
          expect(callGatewayFromCli).not.toHaveBeenCalled();
        }
      } finally {
        callGatewayFromCli.mockReset();
        readConfiguredLogTail.mockReset();
      }
    },
  );
});
