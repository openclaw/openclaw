import { expect, it } from "vitest";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE as locked,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE as reserved,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE as removed,
  isAgentHarnessSessionKeyOwnedBy as owns,
  isValidAgentHarnessSessionStoreEntry as valid,
  resolveAgentHarnessSessionIdMismatchError as mismatch,
  resolveAgentHarnessSessionContextError as contextError,
  resolveAgentHarnessSessionStoreEntryError as entryError,
  resolveAgentHarnessSessionStoreTransitionError as transitionError,
  resolveSessionPinnedHarnessId as pinned,
} from "./agent-harness-session-key.js";

const harnessKey = "agent:main:harness:codex:supervision:native-thread";
const ordinaryKey = "agent:main:ordinary";
const lockedEntry = {
  agentHarnessId: "codex",
  modelSelectionLocked: true,
  sessionId: "native-session",
};
const legacyLock = { modelSelectionLocked: true, sessionId: "native-session" };
it.each([
  [harnessKey, "codex", true],
  [harnessKey, "CODEX-APP-SERVER", true],
  [harnessKey, "other", false],
  [ordinaryKey, "codex", false],
  ["agent:main:harness:foo:bar:thread", "foo", true],
  ["agent:main:harness:foo:bar:thread", "foo:bar", false],
] as const)("binds %s to the exact owner %s", (key, owner, expected) => {
  expect(owns(key, owner)).toBe(expected);
});

it("compares the exact owner segment instead of an owner-id prefix", () => {
  const key = "agent:main:harness:foo:bar:native-thread";
  const checkOwner = (agentHarnessId: string) =>
    entryError(key, { ...lockedEntry, agentHarnessId });
  expect(checkOwner("foo:bar")).toBe(reserved);
  expect(checkOwner("foo")).toBeUndefined();
});

it.each([
  [harnessKey, lockedEntry, undefined, true],
  [harnessKey, { ...lockedEntry, modelSelectionLocked: false }, undefined, false],
  [ordinaryKey, { modelSelectionLocked: false }, undefined, false],
  [ordinaryKey, lockedEntry, undefined, true],
  [ordinaryKey, legacyLock, undefined, false],
  [harnessKey, { ...lockedEntry, pluginOwnerId: "plugin" }, reserved, false],
] as const)("validates durable row %s: %j", (key, entry, error, protectedRow) => {
  expect(entryError(key, entry)).toBe(error);
  expect(valid(key, entry)).toBe(protectedRow);
});

it("requires a valid durable row for protected reserved runtime contexts", () => {
  expect(contextError(harnessKey, undefined)).toBe(reserved);
  expect(contextError(harnessKey, { ...lockedEntry, modelSelectionLocked: false })).toBeUndefined();
  expect(contextError(harnessKey, { agentHarnessId: "codex", modelSelectionLocked: true })).toBe(
    locked,
  );
  expect(contextError(harnessKey, lockedEntry)).toBeUndefined();
  expect(contextError(ordinaryKey, undefined)).toBeUndefined();
});

it("rejects a caller-selected session id that would rotate a durable lock", () => {
  expect(mismatch(lockedEntry, "native-session")).toBeUndefined();
  expect(mismatch(lockedEntry, "replacement-session")).toBe(locked);
});

it("does not turn plugin runtime observation into harness ownership", () => {
  const entry = { ...lockedEntry, sessionId: "ordinary-session", pluginOwnerId: "model-owner" };
  expect(pinned(entry)).toBeUndefined();
  expect(valid(ordinaryKey, entry)).toBe(false);
  expect(mismatch(entry, "replacement-session")).toBeUndefined();
});

it("allows plugin-owned observations to change without releasing the lock or identity", () => {
  const entry = {
    sessionId: "session",
    modelSelectionLocked: true,
    pluginOwnerId: "model-owner",
  };
  const next = { ...entry, agentHarnessId: "codex" };
  const transition = (patch: Partial<typeof next>, previous = entry) =>
    transitionError({
      before: new Map([[ordinaryKey, previous]]),
      store: { [ordinaryKey]: { ...next, ...patch } },
    });
  expect(transition({})).toBeUndefined();
  expect(transition({ agentHarnessId: "claude-cli" }, next)).toBeUndefined();
  for (const patch of [
    { pluginOwnerId: undefined },
    { pluginOwnerId: "other" },
    { modelSelectionLocked: false },
  ]) {
    expect(transition(patch)).toBe(removed);
  }
  expect(transition({ sessionId: "replacement" })).toBe(locked);
  expect(
    transitionError({
      before: new Map([[ordinaryKey, entry]]),
      store: {},
    }),
  ).toBe(removed);
});
