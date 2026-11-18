import { describe, expect, it, vi } from "vitest";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { finalizeDoctorConfigFlow } from "./finalize-config-flow.js";

describe("doctor finalize config flow", () => {
  it.each([
    // name, repair, pending, accepted, write, useCandidate
    ["confirmed preview", false, true, true, true, true],
    ["declined preview", false, true, false, false, false],
    ["automatic repair", true, true, true, true, false],
    ["unchanged preview", false, false, true, false, false],
    ["unchanged repair", true, false, true, false, false],
  ] as const)(
    "finalizes %s against the original revision",
    async (_name, repair, pending, accepted, write, useCandidate) => {
      const cfg = {};
      const candidate = { channels: { signal: { enabled: false } } };
      const snapshot = { path: "/config.json", hash: "source-hash", raw: null };
      const hint = 'Run "openclaw doctor --fix" to apply these changes.';
      const note = vi.fn();
      const confirm = vi.fn(async () => {
        snapshot.path = "/different.json";
        snapshot.hash = "different-revision";
        return accepted;
      });
      const result = await finalizeDoctorConfigFlow({
        cfg,
        candidate,
        snapshot,
        pendingChanges: pending,
        shouldRepair: repair,
        fixHints: [hint],
        confirm,
        note,
      });
      expect(result).toEqual({
        cfg: useCandidate ? candidate : cfg,
        shouldWriteConfig: write,
        confirmedConfigSource: { path: "/config.json", hash: "source-hash" },
      });
      expect(confirm).toHaveBeenCalledTimes(!repair && pending ? 1 : 0);
      expect(note.mock.calls).toEqual(accepted ? [] : [[hint, "Doctor"]]);
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
});
