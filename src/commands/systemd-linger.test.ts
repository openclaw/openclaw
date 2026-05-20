import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  detectSystemdUserLingerFindings,
  repairSystemdUserLingerFinding,
} from "./systemd-linger.js";

function runtime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("systemd linger health", () => {
  it("detects disabled linger for systemd user services", async () => {
    await expect(
      detectSystemdUserLingerFindings({
        platform: "linux",
        deps: {
          isSystemdUserServiceAvailable: vi.fn(async () => true),
          readSystemdUserLingerStatus: vi.fn(async () => ({
            user: "alice",
            linger: "no" as const,
          })),
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        kind: "disabled",
        user: "alice",
        fixHint: "Run manually: sudo loginctl enable-linger alice",
      }),
    );
  });

  it("repairs disabled linger and clears the next detection", async () => {
    let linger: "no" | "yes" = "no";
    const confirm = vi.fn(async () => true);
    const enableSystemdUserLinger = vi.fn(async () => {
      linger = "yes";
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    const deps = {
      isSystemdUserServiceAvailable: vi.fn(async () => true),
      readSystemdUserLingerStatus: vi.fn(async () => ({ user: "alice", linger })),
      enableSystemdUserLinger,
    };

    await expect(
      repairSystemdUserLingerFinding({
        runtime: runtime(),
        platform: "linux",
        confirm,
        deps,
      }),
    ).resolves.toEqual({
      status: "repaired",
      changes: ["Enabled systemd lingering for alice."],
      warnings: [],
    });

    expect(confirm).toHaveBeenCalledWith({
      message: "Enable systemd lingering for alice?",
      initialValue: true,
    });
    expect(enableSystemdUserLinger).toHaveBeenCalledWith({
      env: process.env,
      user: "alice",
    });
    await expect(detectSystemdUserLingerFindings({ platform: "linux", deps })).resolves.toEqual([]);
  });

  it("falls back to sudo prompt when direct linger enable fails", async () => {
    const enableSystemdUserLinger = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "permission denied", code: 1 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", code: 0 });

    await expect(
      repairSystemdUserLingerFinding({
        runtime: runtime(),
        platform: "linux",
        confirm: vi.fn(async () => true),
        deps: {
          isSystemdUserServiceAvailable: vi.fn(async () => true),
          readSystemdUserLingerStatus: vi.fn(async () => ({
            user: "alice",
            linger: "no" as const,
          })),
          enableSystemdUserLinger,
        },
      }),
    ).resolves.toMatchObject({
      status: "repaired",
      changes: ["Enabled systemd lingering for alice."],
    });

    expect(enableSystemdUserLinger).toHaveBeenLastCalledWith({
      env: process.env,
      user: "alice",
      sudoMode: "prompt",
    });
  });

  it("skips repair when the user declines the confirmation", async () => {
    const enableSystemdUserLinger = vi.fn();

    await expect(
      repairSystemdUserLingerFinding({
        runtime: runtime(),
        platform: "linux",
        confirm: vi.fn(async () => false),
        deps: {
          isSystemdUserServiceAvailable: vi.fn(async () => true),
          readSystemdUserLingerStatus: vi.fn(async () => ({
            user: "alice",
            linger: "no" as const,
          })),
          enableSystemdUserLinger,
        },
      }),
    ).resolves.toEqual({
      status: "skipped",
      changes: [],
      warnings: ["Without lingering, the Gateway will stop when you log out."],
    });

    expect(enableSystemdUserLinger).not.toHaveBeenCalled();
  });
});
