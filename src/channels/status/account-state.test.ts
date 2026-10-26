import { describe, expect, it } from "vitest";
import {
  applyChannelAccountState,
  projectChannelAccountDisplayState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
} from "./account-state.js";

const baseInput = {
  enabled: true,
  configured: true,
  linked: true,
  runtime: {},
  disabledReason: "disabled reason",
  unconfiguredReason: "unconfigured reason",
  unlinkedReason: "unlinked reason",
} as const;
const stoppedState = { configured: true, running: false, lastError: null };

describe("resolveChannelAccountState", () => {
  it.each([
    [
      "disabled wins over later states",
      { enabled: false, configured: false, linked: false, runtime: { running: true } },
      { configured: false, linked: false, stateReason: "disabled reason" },
    ],
    [
      "unconfigured wins over linkage and runtime",
      { configured: false, linked: false, runtime: { running: true } },
      { configured: false, stateReason: "unconfigured reason" },
    ],
    [
      "explicitly unlinked wins over runtime",
      { linked: false, runtime: { running: true } },
      { linked: false, stateReason: "unlinked reason" },
    ],
    [
      "running owns linkage, connectivity, and failure",
      { runtime: { running: true, connected: true, lastError: "not linked" } },
      { linked: true, running: true, connected: true, lastError: "not linked" },
    ],
    [
      "running preserves explicit disconnected status",
      { runtime: { running: true, connected: false } },
      { linked: true, running: true, connected: false },
    ],
    [
      // Manufacturing connected:false restarts socketless channels every cooldown window.
      "running keeps connectivity absent when the transport publishes none",
      { runtime: { running: true } },
      { linked: true, running: true },
    ],
    [
      "stopped owns linkage, connectivity, and failure",
      { runtime: { connected: true, lastError: "transport failed" } },
      { linked: true, connected: true, lastError: "transport failed" },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(resolveChannelAccountState({ ...baseInput, ...input }).snapshot).toEqual({
      ...stoppedState,
      ...expected,
    });
  });

  it.each([false, true])("keeps unknown linkage configured (running=%s)", (running) => {
    const { snapshot } = resolveChannelAccountState({
      ...baseInput,
      linked: undefined,
      runtime: { running },
    });
    expect(snapshot).toMatchObject({ configured: true, running });
    expect(snapshot).not.toHaveProperty("linked");
  });

  it.each([
    ["linked", true],
    ["not-linked", false],
    ["unknown", undefined],
    [undefined, true],
  ] as const)("maps link state %s", (state, expected) => {
    expect(resolveChannelAccountLinked(state, true)).toBe(expected);
  });
  it("replaces owner fields while preserving unrelated snapshot data", () => {
    const state = resolveChannelAccountState({ ...baseInput, linked: undefined });
    const snapshot = {
      accountId: "default",
      configured: false,
      linked: false,
      running: true,
      connected: true,
      stateReason: "not linked",
      lastError: "not linked",
      mode: "polling",
    };
    applyChannelAccountState(snapshot, state);
    expect(snapshot).toEqual({ accountId: "default", ...stoppedState, mode: "polling" });
    expect(projectChannelAccountDisplayState(state)).toBe("configured");
    expect(projectChannelAccountDisplayState(state, "enabled")).toBe("enabled");
  });
});
