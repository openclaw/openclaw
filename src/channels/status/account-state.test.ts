import { expect, it } from "vitest";
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
  runtime: { running: true },
  disabledReason: "disabled reason",
  unconfiguredReason: "unconfigured reason",
  unlinkedReason: "unlinked reason",
} as const;
const stoppedState = { configured: true, running: false, lastError: null };

it.each([
  [
    { enabled: false, configured: false, linked: false },
    { configured: false, linked: false, stateReason: "disabled reason" },
  ],
  [
    { configured: false, linked: false },
    { configured: false, stateReason: "unconfigured reason" },
  ],
  [{ linked: false }, { linked: false, stateReason: "unlinked reason" }],
  [
    { runtime: { running: true, connected: true, lastError: "not linked" } },
    { linked: true, running: true, connected: true, lastError: "not linked" },
  ],
  [
    { runtime: { running: true, connected: false } },
    { linked: true, running: true, connected: false },
  ],
  // Socketless transports must not acquire a manufactured connected:false.
  [{}, { linked: true, running: true }],
  [
    { runtime: { connected: true, lastError: "transport failed" } },
    { linked: true, connected: true, lastError: "transport failed" },
  ],
] as const)("projects account state for %j", (input, expected) => {
  const { snapshot } = resolveChannelAccountState({ ...baseInput, ...input });
  expect(snapshot).toEqual({ ...stoppedState, ...expected });
});

it.each([false, true])("keeps unknown linkage configured (running=%s)", (running) => {
  const input = { ...baseInput, linked: undefined, runtime: { running } };
  const { snapshot } = resolveChannelAccountState(input);
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
  const state = resolveChannelAccountState({ ...baseInput, linked: undefined, runtime: {} });
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
