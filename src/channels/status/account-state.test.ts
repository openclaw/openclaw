import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../plugins/types.core.js";
import {
  applyChannelAccountState,
  projectChannelAccountDisplayState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
} from "./account-state.js";

// The projection is module-internal; exercise it through the public merge helper
// so the test does not force a wider export surface than production needs.
function projectChannelAccountState(state: Parameters<typeof applyChannelAccountState>[1]) {
  const snapshot: ChannelAccountSnapshot = { accountId: "default" };
  applyChannelAccountState(snapshot, state);
  const { accountId: _accountId, ...projected } = snapshot;
  return projected;
}

const baseInput = {
  enabled: true,
  configured: true,
  linked: true,
  runtime: {},
  disabledReason: "disabled reason",
  unconfiguredReason: "unconfigured reason",
  unlinkedReason: "unlinked reason",
} as const;

describe("resolveChannelAccountState", () => {
  it.each([
    [
      "disabled wins over later states",
      { enabled: false, configured: false, linked: false, runtime: { running: true } },
      {
        configured: false,
        linked: false,
        running: false,
        stateReason: "disabled reason",
        lastError: null,
      },
    ],
    [
      "unconfigured wins over linkage and runtime",
      { configured: false, linked: false, runtime: { running: true } },
      { configured: false, running: false, stateReason: "unconfigured reason", lastError: null },
    ],
    [
      "explicitly unlinked wins over runtime",
      { linked: false, runtime: { running: true } },
      {
        configured: true,
        linked: false,
        running: false,
        stateReason: "unlinked reason",
        lastError: null,
      },
    ],
    [
      "running owns linkage, connectivity, and failure",
      { runtime: { running: true, connected: true, lastError: "not linked" } },
      { configured: true, linked: true, running: true, connected: true, lastError: "not linked" },
    ],
    [
      "running preserves explicit disconnected status",
      { runtime: { running: true, connected: false } },
      { configured: true, linked: true, running: true, connected: false, lastError: null },
    ],
    [
      // Manufacturing connected:false restarts socketless channels every cooldown window.
      "running keeps connectivity absent when the transport publishes none",
      { runtime: { running: true } },
      { configured: true, linked: true, running: true, lastError: null },
    ],
    [
      "stopped owns linkage, connectivity, and failure",
      { runtime: { connected: true, lastError: "transport failed" } },
      {
        configured: true,
        linked: true,
        running: false,
        connected: true,
        lastError: "transport failed",
      },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(
      projectChannelAccountState(resolveChannelAccountState({ ...baseInput, ...input })),
    ).toEqual(expected);
  });

  it.each([false, true])("keeps unknown linkage configured (running=%s)", (running) => {
    const state = resolveChannelAccountState({
      ...baseInput,
      linked: undefined,
      runtime: { running },
    });
    expect(state.kind).toBe(running ? "running" : "stopped");
    expect(projectChannelAccountState(state)).toMatchObject({ configured: true });
    expect(projectChannelAccountState(state)).not.toHaveProperty("linked");
  });

  it.each([
    ["linked", true],
    ["not-linked", false],
    ["unknown", undefined],
    [undefined, true],
  ] as const)("maps link state %s", (state, expected) => {
    expect(resolveChannelAccountLinked(state, true)).toBe(expected);
  });
});

describe("projectChannelAccountState", () => {
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
    expect(snapshot).toEqual({
      accountId: "default",
      configured: true,
      running: false,
      lastError: null,
      mode: "polling",
    });
    expect(projectChannelAccountDisplayState(state)).toBe("configured");
    expect(projectChannelAccountDisplayState(state, "enabled")).toBe("enabled");
  });
});
