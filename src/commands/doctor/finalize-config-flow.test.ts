import { describe, expect, it, vi } from "vitest";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { finalizeDoctorConfigFlow } from "./finalize-config-flow.js";

describe("doctor finalize config flow", () => {
  it.each([
    {
      name: "confirmed preview",
      repair: false,
      pending: true,
      accepted: true,
      write: true,
      candidate: true,
    },
    {
      name: "declined preview",
      repair: false,
      pending: true,
      accepted: false,
      write: false,
      candidate: false,
    },
    {
      name: "automatic repair",
      repair: true,
      pending: true,
      accepted: true,
      write: true,
      candidate: false,
    },
    {
      name: "unchanged preview",
      repair: false,
      pending: false,
      accepted: true,
      write: false,
      candidate: false,
    },
    {
      name: "unchanged repair",
      repair: true,
      pending: false,
      accepted: true,
      write: false,
      candidate: false,
    },
  ])("finalizes $name against the original revision", async (scenario) => {
    const cfg = { channels: { signal: { enabled: true } } };
    const candidate = { channels: { signal: { enabled: false } } };
    const snapshot = { path: "/config.json", hash: "source-hash", raw: null };
    const hint = 'Run "openclaw doctor --fix" to apply these changes.';
    const note = vi.fn();
    const confirm = vi.fn(async () => {
      snapshot.path = "/different.json";
      snapshot.hash = "different-revision";
      return scenario.accepted;
    });
    const result = await finalizeDoctorConfigFlow({
      cfg,
      candidate,
      snapshot,
      pendingChanges: scenario.pending,
      shouldRepair: scenario.repair,
      fixHints: [hint],
      confirm,
      note,
    });
    expect(result).toEqual({
      cfg: scenario.candidate ? candidate : cfg,
      shouldWriteConfig: scenario.write,
      confirmedConfigSource: { path: "/config.json", hash: "source-hash" },
    });
    expect(confirm).toHaveBeenCalledTimes(!scenario.repair && scenario.pending ? 1 : 0);
    if (!scenario.accepted) {
      expect(note).toHaveBeenCalledWith(hint, "Doctor");
    } else {
      expect(note).not.toHaveBeenCalled();
    }
  });

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
});
