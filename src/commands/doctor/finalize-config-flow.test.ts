import { describe, expect, it, vi } from "vitest";
import { finalizeDoctorConfigFlow } from "./finalize-config-flow.js";

describe("doctor finalize config flow", () => {
  it("writes the candidate when preview changes are confirmed", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      shouldRepair: false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      confirm: async () => true,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("emits fix hints when preview changes are declined", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      shouldRepair: false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      confirm: async () => false,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: {} },
      shouldWriteConfig: false,
    });
    expect(note).toHaveBeenCalledWith(
      'Run "openclaw doctor --fix" to apply these changes.',
      "Doctor",
    );
  });

  it("emits diff and skips write in dry-run mode with pending changes", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      shouldRepair: false,
      dryRun: true,
      fixHints: [],
      confirm: async () => true,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: {} },
      shouldWriteConfig: false,
    });
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0]?.[1]).toBe("Dry run \u2014 proposed changes (not applied)");
    expect(note.mock.calls[0]?.[0]).toContain("channels.signal.enabled");
  });

  it("emits no-changes note in dry-run mode without pending changes", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: {} },
      pendingChanges: true,
      shouldRepair: false,
      dryRun: true,
      fixHints: [],
      confirm: async () => true,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: {} },
      shouldWriteConfig: false,
    });
    expect(note).toHaveBeenCalledWith("No config changes detected.", "Dry run");
  });

  it("dry-run takes precedence over repair mode", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      shouldRepair: true,
      dryRun: true,
      fixHints: [],
      confirm: async () => true,
      note,
    });

    expect(result.shouldWriteConfig).toBe(false);
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0]?.[1]).toBe("Dry run \u2014 proposed changes (not applied)");
  });

  it("writes automatically in repair mode when changes exist", async () => {
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: false } } },
      pendingChanges: true,
      shouldRepair: true,
      fixHints: [],
      confirm: async () => true,
      note: vi.fn(),
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
    });
  });
});
