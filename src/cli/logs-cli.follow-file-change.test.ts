// Regression coverage for `--follow` across Gateway log-file changes.
//
// A Gateway byte cursor only addresses one file. When the Gateway rotates to a
// different log path, `--follow` must reread the new file without the stale
// cursor instead of replaying the old cursor against the new file (see
// docs/cli/logs.md). These cases cover the plain/JSON rendering paths, the
// systemd-journal bridge, and a failed cursorless reread.
import { describe, expect, it, vi } from "vitest";
import {
  callGatewayFromCli,
  captureStderrWrites,
  captureStdoutWrites,
  createGatewayCloseError,
  execFileUtf8Tail,
  readSystemdServiceRuntime,
  runLogsCli,
  useLogsCliTestHarness,
} from "./logs-cli.test-harness.js";

describe("logs cli follow across Gateway log-file changes", () => {
  useLogsCliTestHarness();

  it.each([
    { mode: "plain", bridge: false, failReread: false },
    { mode: "json", bridge: false, failReread: false },
    { mode: "json", bridge: true, failReread: false },
    { mode: "plain", bridge: false, failReread: true },
  ])(
    "reads the complete new file in $mode mode (journal: $bridge, failed reread: $failReread)",
    async ({ mode, bridge, failReread }) => {
      const closeError = createGatewayCloseError({
        code: 1006,
        reason: "abnormal closure",
        message: "gateway closed (1006 abnormal closure): abnormal closure",
      });
      callGatewayFromCli.mockResolvedValueOnce({
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
      callGatewayFromCli.mockImplementation(
        async (_method, _options, { cursor }: { cursor?: number }) => {
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
        },
      );
      const stdoutWrites = captureStdoutWrites();
      captureStderrWrites();
      vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

      try {
        await runLogsCli(["logs", "--follow", `--${mode}`, "--interval", "1"]);
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
      } finally {
        callGatewayFromCli.mockReset();
      }
    },
  );
});
