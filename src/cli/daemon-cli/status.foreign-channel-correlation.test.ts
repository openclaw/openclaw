import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "./status.gather.js";
import { printDaemonStatus } from "./status.print.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn<(line: string) => void>(),
  error: vi.fn<(line: string) => void>(),
  writeJson: vi.fn<(value: unknown) => void>(),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: runtime }));

vi.mock("./status.gather.js", () => ({
  renderPortDiagnosticsForCli: () => [],
  resolvePortListeningAddresses: () => [],
}));

describe("foreign channel conflict correlation", () => {
  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.writeJson.mockReset();
  });

  it.each([false, true])("names the possible duplicate-poller install with json=%s", (json) => {
    const job = {
      label: "ai.openclaw.ocm",
      program: "/tmp/other-openclaw/openclaw",
      keepAlive: true,
      gatewayActions: [],
      safeToRemove: false,
    };
    const status: DaemonStatus = {
      service: {
        label: "LaunchAgent",
        loaded: true,
        loadState: { status: "loaded" },
        loadedText: "loaded",
        notLoadedText: "not loaded",
        foreignLaunchdJobs: [job],
      },
      rpc: {
        ok: true,
        kind: "connect",
        channelStatusIssues: [
          {
            channel: "telegram",
            accountId: "default",
            kind: "runtime",
            message: "Telegram getUpdates conflict: another poller is using this bot token",
          },
        ],
      },
      extraServices: [],
    };

    printDaemonStatus(status, { json, deep: true });

    if (json) {
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          foreignChannelConflictCorrelations: [
            expect.objectContaining({
              channel: "telegram",
              accountId: "default",
              foreignJobs: [{ label: job.label, program: job.program }],
            }),
          ],
        }),
      );
      return;
    }
    const output = runtime.error.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("duplicate-poller conflict");
    expect(output).toContain("telegram/default");
    expect(output).toContain(job.label);
    expect(output).toContain(job.program);
  });
});
