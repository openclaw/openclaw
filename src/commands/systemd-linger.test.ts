import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSystemdUserLingerNonInteractive } from "./systemd-linger.js";

const mocks = vi.hoisted(() => ({
  enableSystemdUserLinger: vi.fn(),
  isSystemdUserServiceAvailable: vi.fn(async () => true),
  readSystemdUserLingerStatus: vi.fn(async () => ({ user: "alice", linger: "no" as const })),
}));

vi.mock("../daemon/systemd.js", () => mocks);

describe("ensureSystemdUserLingerNonInteractive", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(true);
    mocks.readSystemdUserLingerStatus.mockResolvedValue({ user: "alice", linger: "no" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("routes failed non-interactive enablement through the warning callback", async () => {
    mocks.enableSystemdUserLinger.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "sudo: a password is required",
      code: 1,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const warn = vi.fn();

    await ensureSystemdUserLingerNonInteractive({ runtime, warn });

    expect(warn).toHaveBeenCalledWith(
      "Systemd lingering is disabled for alice. Run: sudo loginctl enable-linger alice",
    );
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps successful enablement as informational output", async () => {
    mocks.enableSystemdUserLinger.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const warn = vi.fn();

    await ensureSystemdUserLingerNonInteractive({ runtime, warn });

    expect(runtime.log).toHaveBeenCalledWith("Enabled systemd lingering for alice.");
    expect(warn).not.toHaveBeenCalled();
  });
});
