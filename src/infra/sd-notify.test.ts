import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  _resetWatchdogWarned,
  sdNotifyExtendTimeout,
  sdNotifyReady,
  sdNotifyWatchdog,
  startWatchdogHeartbeat,
} from "./sd-notify.js";

describe("sdNotifyReady", () => {
  const origNotifySocket = process.env.NOTIFY_SOCKET;

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    if (origNotifySocket === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = origNotifySocket;
    }
  });

  it("is a no-op when NOTIFY_SOCKET is not set", () => {
    delete process.env.NOTIFY_SOCKET;
    sdNotifyReady();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("calls systemd-notify --ready when NOTIFY_SOCKET is set", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    sdNotifyReady();
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock).toHaveBeenCalledWith(
      "systemd-notify",
      ["--ready"],
      { timeout: 5000 },
      expect.any(Function),
    );
  });

  it("warns on stderr when execFile fails", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(new Error("spawn ENOENT"));
      },
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    sdNotifyReady();
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to send READY=1"));
    stderrSpy.mockRestore();
  });
});

describe("sdNotifyExtendTimeout", () => {
  const origNotifySocket = process.env.NOTIFY_SOCKET;

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    if (origNotifySocket === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = origNotifySocket;
    }
  });

  it("is a no-op when NOTIFY_SOCKET is not set", () => {
    delete process.env.NOTIFY_SOCKET;
    sdNotifyExtendTimeout(300);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("sends EXTEND_TIMEOUT_USEC with correct microsecond value", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    sdNotifyExtendTimeout(600);
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock).toHaveBeenCalledWith(
      "systemd-notify",
      ["EXTEND_TIMEOUT_USEC=600000000"],
      { timeout: 5000 },
      expect.any(Function),
    );
  });

  it("warns on stderr when execFile fails", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(new Error("spawn ENOENT"));
      },
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    sdNotifyExtendTimeout(600);
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to extend startup timeout"),
    );
    stderrSpy.mockRestore();
  });
});

describe("sdNotifyWatchdog", () => {
  const origNotifySocket = process.env.NOTIFY_SOCKET;

  beforeEach(() => {
    execFileMock.mockReset();
    _resetWatchdogWarned();
  });

  afterEach(() => {
    if (origNotifySocket === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = origNotifySocket;
    }
  });

  it("is a no-op when NOTIFY_SOCKET is not set", () => {
    delete process.env.NOTIFY_SOCKET;
    sdNotifyWatchdog();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("calls systemd-notify WATCHDOG=1 when NOTIFY_SOCKET is set", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    sdNotifyWatchdog();
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock).toHaveBeenCalledWith(
      "systemd-notify",
      ["WATCHDOG=1"],
      { timeout: 5000 },
      expect.any(Function),
    );
  });

  it("warns on stderr on first error only", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(new Error("spawn ENOENT"));
      },
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    sdNotifyWatchdog();
    sdNotifyWatchdog();
    sdNotifyWatchdog();
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed to send WATCHDOG=1"));
    stderrSpy.mockRestore();
  });

  it("skips when a previous call is still in flight", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    // Hold the callback — simulate a slow execFile that hasn't completed yet
    let pendingCb: ((err: Error | null) => void) | undefined;
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        pendingCb = cb;
      },
    );

    sdNotifyWatchdog(); // first call — in flight
    expect(execFileMock).toHaveBeenCalledOnce();

    sdNotifyWatchdog(); // second call — should be skipped (first still pending)
    expect(execFileMock).toHaveBeenCalledOnce();

    // Complete the first call
    pendingCb!(null);

    sdNotifyWatchdog(); // third call — should proceed (first completed)
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("startWatchdogHeartbeat", () => {
  const origNotifySocket = process.env.NOTIFY_SOCKET;
  const origWatchdogUsec = process.env.WATCHDOG_USEC;

  beforeEach(() => {
    execFileMock.mockReset();
    _resetWatchdogWarned();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origNotifySocket === undefined) {
      delete process.env.NOTIFY_SOCKET;
    } else {
      process.env.NOTIFY_SOCKET = origNotifySocket;
    }
    if (origWatchdogUsec === undefined) {
      delete process.env.WATCHDOG_USEC;
    } else {
      process.env.WATCHDOG_USEC = origWatchdogUsec;
    }
  });

  it("returns undefined when NOTIFY_SOCKET is not set", () => {
    delete process.env.NOTIFY_SOCKET;
    process.env.WATCHDOG_USEC = "90000000";
    expect(startWatchdogHeartbeat()).toBeUndefined();
  });

  it("returns undefined when WATCHDOG_USEC is not set", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    delete process.env.WATCHDOG_USEC;
    expect(startWatchdogHeartbeat()).toBeUndefined();
  });

  it("sends immediate heartbeat and starts interval at half WATCHDOG_USEC", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    process.env.WATCHDOG_USEC = "90000000"; // 90s
    // Mock calls the callback immediately so the in-flight guard clears
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null);
      },
    );
    const cleanup = startWatchdogHeartbeat();
    expect(cleanup).toBeTypeOf("function");

    // Immediate heartbeat on start
    expect(execFileMock).toHaveBeenCalledOnce();

    // Advance to half of 90s = 45s
    vi.advanceTimersByTime(45_000);
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // Another 45s
    vi.advanceTimersByTime(45_000);
    expect(execFileMock).toHaveBeenCalledTimes(3);

    cleanup!();
  });

  it("cleanup stops the interval", () => {
    process.env.NOTIFY_SOCKET = "/run/user/1000/systemd/notify";
    process.env.WATCHDOG_USEC = "90000000";
    // Mock calls the callback immediately so the in-flight guard clears
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null);
      },
    );
    const cleanup = startWatchdogHeartbeat();
    expect(execFileMock).toHaveBeenCalledOnce();

    cleanup!();
    vi.advanceTimersByTime(90_000);
    // No additional calls after cleanup
    expect(execFileMock).toHaveBeenCalledOnce();
  });
});
