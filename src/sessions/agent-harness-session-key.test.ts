import { expect, it } from "vitest";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionIdMismatchError,
  resolveAgentHarnessSessionContextError,
  resolveAgentHarnessSessionStoreEntryError,
  resolveAgentHarnessSessionStoreTransitionError,
  resolveMissingAgentHarnessSessionError,
  resolveSessionPinnedHarnessId,
} from "./agent-harness-session-key.js";

const harnessKey = "agent:main:harness:codex:supervision:native-thread";
const ordinaryKey = "agent:main:ordinary";
const lockedEntry = {
  agentHarnessId: "codex",
  modelSelectionLocked: true,
  sessionId: "native-session",
};
const entryError = (entry: Parameters<typeof resolveAgentHarnessSessionStoreEntryError>[1]) =>
  resolveAgentHarnessSessionStoreEntryError(harnessKey, entry);
const contextError = (entry: Parameters<typeof resolveAgentHarnessSessionContextError>[1]) =>
  resolveAgentHarnessSessionContextError(harnessKey, entry);

it("recognizes the reserved namespace", () => {
  const sessionKey = "harness:codex:supervision:native-thread";
  expect(isAgentHarnessSessionKey(sessionKey)).toBe(true);
  expect(resolveMissingAgentHarnessSessionError(sessionKey, undefined)).toMatch(/reserved/i);
  expect(resolveMissingAgentHarnessSessionError(sessionKey, { sessionId: "existing" })).toBe(
    undefined,
  );
});

it("ties trusted creation to the matching persisted harness owner", () => {
  expect(isAgentHarnessSessionKeyOwnedBy(harnessKey, "codex")).toBe(true);
  expect(isAgentHarnessSessionKeyOwnedBy(harnessKey, "CODEX-APP-SERVER")).toBe(true);
  expect(isAgentHarnessSessionKeyOwnedBy(harnessKey, "other")).toBe(false);
  expect(isAgentHarnessSessionKeyOwnedBy(ordinaryKey, "codex")).toBe(false);
});

it("compares the exact owner segment instead of an owner-id prefix", () => {
  const key = "agent:main:harness:foo:bar:native-thread";
  const checkOwner = (agentHarnessId: string) =>
    resolveAgentHarnessSessionStoreEntryError(key, { ...lockedEntry, agentHarnessId });
  expect(isAgentHarnessSessionKeyOwnedBy(key, "foo")).toBe(true);
  expect(isAgentHarnessSessionKeyOwnedBy(key, "foo:bar")).toBe(false);
  expect(checkOwner("foo:bar")).toBe(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
  expect(checkOwner("foo")).toBeUndefined();
});

it("validates durable lock metadata for reserved and ordinary rows", () => {
  const legacyLock = { modelSelectionLocked: true, sessionId: "native-session" };
  expect(entryError(lockedEntry)).toBeUndefined();
  expect(entryError({ ...lockedEntry, modelSelectionLocked: false })).toBeUndefined();
  expect(
    resolveAgentHarnessSessionStoreEntryError(ordinaryKey, {
      modelSelectionLocked: false,
    }),
  ).toBeUndefined();
  expect(isValidAgentHarnessSessionStoreEntry(ordinaryKey, lockedEntry)).toBe(true);
  expect(resolveAgentHarnessSessionStoreEntryError(ordinaryKey, legacyLock)).toBeUndefined();
  expect(isValidAgentHarnessSessionStoreEntry(ordinaryKey, legacyLock)).toBe(false);
});

it("requires a valid durable row for protected reserved runtime contexts", () => {
  expect(contextError(undefined)).toMatch(/reserved/i);
  expect(contextError({ ...lockedEntry, modelSelectionLocked: false })).toBeUndefined();
  expect(contextError({ agentHarnessId: "codex", modelSelectionLocked: true })).toBe(
    AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  );
  expect(contextError(lockedEntry)).toBeUndefined();
  expect(resolveAgentHarnessSessionContextError(ordinaryKey, undefined)).toBeUndefined();
});

it("rejects a caller-selected session id that would rotate a durable lock", () => {
  expect(resolveAgentHarnessSessionIdMismatchError(lockedEntry, "native-session")).toBeUndefined();
  expect(resolveAgentHarnessSessionIdMismatchError(lockedEntry, "replacement-session")).toBe(
    AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  );
});

it("does not turn plugin runtime observation into harness ownership", () => {
  const entry = {
    ...lockedEntry,
    sessionId: "ordinary-session",
    pluginOwnerId: "model-owner",
  };

  expect(resolveSessionPinnedHarnessId(entry)).toBeUndefined();
  expect(isValidAgentHarnessSessionStoreEntry(ordinaryKey, entry)).toBe(false);
  expect(resolveAgentHarnessSessionIdMismatchError(entry, "replacement-session")).toBeUndefined();
});

it("allows plugin-owned observations to change without releasing the lock or identity", () => {
  const entry = {
    sessionId: "session",
    modelSelectionLocked: true,
    pluginOwnerId: "model-owner",
  };
  const next = { ...entry, agentHarnessId: "codex" };
  const transition = (patch: Partial<typeof next>, previous = entry) =>
    resolveAgentHarnessSessionStoreTransitionError({
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
    expect(transition(patch)).toBe(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
  }
  expect(transition({ sessionId: "replacement" })).toBe(AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE);
  expect(
    resolveAgentHarnessSessionStoreTransitionError({
      before: new Map([[ordinaryKey, entry]]),
      store: {},
    }),
  ).toBe(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
});

it("rejects mixed plugin ownership in the reserved native namespace", () => {
  const key = "agent:main:harness:codex:thread";
  const entry = { ...lockedEntry, sessionId: "session", pluginOwnerId: "model-owner" };
  expect(resolveAgentHarnessSessionStoreEntryError(key, entry)).toBe(
    AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  );
  expect(isValidAgentHarnessSessionStoreEntry(key, entry)).toBe(false);
});
