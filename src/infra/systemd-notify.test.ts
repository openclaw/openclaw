import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessExecFile } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessExecFile(
    Object.assign(execFileMock, {
      __promisify__: vi.fn(),
    }) as typeof import("node:child_process").execFile,
  );
});

import { createSystemdNotifier } from "./systemd-notify.js";

describe("createSystemdNotifier", () => {
  it("does nothing when NOTIFY_SOCKET is absent", async () => {
    execFileMock.mockReset();

    const notifier = createSystemdNotifier({ env: {} });
    await notifier.ready();
    await notifier.watchdog();

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("sends readiness and watchdog notifications through systemd-notify", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));

    const env = { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" };
    const notifier = createSystemdNotifier({ env });

    await notifier.ready();
    await notifier.watchdog();

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "systemd-notify",
      ["--ready", "--status=OpenClaw gateway ready"],
      { env },
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "systemd-notify",
      ["--watchdog", "--status=OpenClaw gateway alive"],
      { env },
      expect.any(Function),
    );
  });

  it("logs once and disables later notifications after systemd-notify fails", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const error = new Error("spawn systemd-notify ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      cb(error, "", "");
    });
    const warn = vi.fn();
    const notifier = createSystemdNotifier({
      env: { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" },
      log: { warn },
    });

    await notifier.watchdog();
    await notifier.watchdog();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("watchdog updates disabled");
  });
});
