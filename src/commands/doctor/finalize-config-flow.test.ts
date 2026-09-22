// Doctor finalize config-flow tests cover final repair summaries and config mutation completion.
import { describe, expect, it, vi } from "vitest";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { finalizeDoctorConfigFlow } from "./finalize-config-flow.js";

describe("doctor finalize config flow", () => {
  it("writes the candidate when preview changes are confirmed", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      snapshot: { path: "/config.json", hash: "source-hash", raw: null },
      pendingChanges: true,
      shouldRepair: false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      confirm: async () => true,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
      confirmedConfigSource: { path: "/config.json", hash: "source-hash" },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("emits fix hints when preview changes are declined", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      snapshot: { path: "/config.json", hash: "source-hash", raw: null },
      pendingChanges: true,
      shouldRepair: false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      confirm: async () => false,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: {} },
      shouldWriteConfig: false,
      confirmedConfigSource: { path: "/config.json", hash: "source-hash" },
    });
    expect(note).toHaveBeenCalledWith(
      'Run "openclaw doctor --fix" to apply these changes.',
      "Doctor",
    );
  });

  it("writes automatically in repair mode when changes exist", async () => {
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: false } } },
      snapshot: { path: "/config.json", hash: "source-hash", raw: null },
      pendingChanges: true,
      shouldRepair: true,
      fixHints: [],
      confirm: async () => true,
      note: vi.fn(),
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
      confirmedConfigSource: { path: "/config.json", hash: "source-hash" },
    });
  });

  it.each([false, true])(
    "retains the planning receipt without changes (repair=%s)",
    async (repair) => {
      const cfg = {};
      const confirm = vi.fn();
      const result = await finalizeDoctorConfigFlow({
        cfg,
        candidate: { gateway: { mode: "local" } },
        snapshot: { path: "/config.json", hash: "source-hash", raw: "{}" },
        pendingChanges: false,
        shouldRepair: repair,
        fixHints: [],
        confirm,
        note: vi.fn(),
      });
      expect(result).toEqual({
        cfg,
        shouldWriteConfig: false,
        confirmedConfigSource: { path: "/config.json", hash: "source-hash" },
      });
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it.each([null, "{}"])(
    "retains the raw revision when the snapshot has no hash (%s)",
    async (raw) => {
      const result = await finalizeDoctorConfigFlow({
        cfg: {},
        candidate: {},
        snapshot: { path: "/config.json", raw },
        pendingChanges: false,
        shouldRepair: false,
        fixHints: [],
        confirm: vi.fn(),
        note: vi.fn(),
      });
      expect(result.confirmedConfigSource).toEqual({
        path: "/config.json",
        hash: hashConfigRaw(raw),
      });
    },
  );

  it("captures the original path and full revision before confirmation awaits", async () => {
    const snapshot = { path: "/planned.json", hash: "include-revision", raw: "{}" };
    const result = await finalizeDoctorConfigFlow({
      cfg: {},
      candidate: { gateway: { mode: "local" } },
      snapshot,
      pendingChanges: true,
      shouldRepair: false,
      fixHints: [],
      confirm: async () => {
        snapshot.path = "/different.json";
        snapshot.hash = "different-revision";
        return true;
      },
      note: vi.fn(),
    });
    expect(result.confirmedConfigSource).toEqual({
      path: "/planned.json",
      hash: "include-revision",
    });
  });
});
