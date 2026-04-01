import { describe, expect, it } from "vitest";
import { applyDoctorConfigMutation } from "./config-mutation-state.js";

describe("doctor config mutation state", () => {
  it("updates candidate and fix hints in preview mode", () => {
    const next = applyDoctorConfigMutation({
      state: {
        cfg: { channels: {} },
        candidate: { channels: {} },
        pendingChanges: false,
        fixHints: [],
      },
      mutation: {
        config: { channels: { signal: { enabled: true } } },
        changes: ["enabled signal"],
      },
      shouldRepair: false,
      fixHint: 'Run "openclaw doctor --fix" to apply these changes.',
    });

    expect(next).toEqual({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
    });
  });

  it("updates cfg directly in repair mode", () => {
    const next = applyDoctorConfigMutation({
      state: {
        cfg: { channels: {} },
        candidate: { channels: {} },
        pendingChanges: false,
        fixHints: [],
      },
      mutation: {
        config: { channels: { signal: { enabled: true } } },
        changes: ["enabled signal"],
      },
      shouldRepair: true,
      fixHint: 'Run "openclaw doctor --fix" to apply these changes.',
    });

    expect(next).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      fixHints: [],
    });
  });

  it("stays unchanged when there are no changes", () => {
    const state = {
      cfg: { channels: {} },
      candidate: { channels: {} },
      pendingChanges: false,
      fixHints: [],
    };

    expect(
      applyDoctorConfigMutation({
        state,
        mutation: { config: { channels: { signal: { enabled: true } } }, changes: [] },
        shouldRepair: false,
      }),
    ).toBe(state);
  });
});
