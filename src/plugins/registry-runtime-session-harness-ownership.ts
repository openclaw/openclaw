import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
  resolveSessionPinnedHarnessId,
} from "../sessions/agent-harness-session-key.js";
import type { PluginRegistry } from "./registry-types.js";

export type SessionOwnershipFields = Pick<
  SessionEntry,
  "modelSelectionLocked" | "pluginOwnerId" | "agentHarnessId"
>;

export function createPluginSessionHarnessOwnership(
  pluginId: string,
  resolveRegistry: () => PluginRegistry,
) {
  const requireHarnessRegistration = (value: unknown, action: string) => {
    const harnessId = normalizeOptionalAgentRuntimeId(value);
    if (!harnessId) {
      throw new Error(
        `Plugin "${pluginId}" must provide a registered agent harness id to ${action}.`,
      );
    }
    const registration = resolveRegistry().agentHarnesses.find(
      (entry) => normalizeOptionalAgentRuntimeId(entry.harness.id) === harnessId,
    );
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" must register agent harness "${harnessId}" before it can ${action}.`,
      );
    }
    return { harnessId, registration };
  };
  const resolveHarnessRegistrationForSessionKey = (sessionKey: string) =>
    resolveRegistry().agentHarnesses.find((entry) => {
      const rawHarnessId = normalizeOptionalString(entry.harness.id)?.toLowerCase();
      return (
        rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId) &&
        isAgentHarnessSessionKeyOwnedBy(sessionKey, rawHarnessId)
      );
    });
  const assertOwnedHarness = (harnessId: unknown, action: string): string => {
    const { harnessId: normalizedHarnessId, registration } = requireHarnessRegistration(
      harnessId,
      action,
    );
    if (registration.pluginId !== pluginId) {
      throw new Error(
        `Agent harness "${normalizedHarnessId}" is owned by plugin "${registration.pluginId}", not "${pluginId}".`,
      );
    }
    return normalizedHarnessId;
  };
  const assertReservedSessionKeyOwned = (sessionKey: unknown, action: string): void => {
    const normalizedSessionKey = normalizeOptionalString(sessionKey);
    if (!normalizedSessionKey || !isAgentHarnessSessionKey(normalizedSessionKey)) {
      return;
    }
    const registration = resolveHarnessRegistrationForSessionKey(normalizedSessionKey);
    if (!registration) {
      throw new Error(
        `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" because its harness is not registered.`,
      );
    }
    if (registration.pluginId !== pluginId) {
      throw new Error(
        `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" owned by plugin "${registration.pluginId}".`,
      );
    }
  };
  const resolveLockedSessionHarnessRegistration = (
    sessionKey: string,
    entry: SessionOwnershipFields,
    action: string,
  ) => {
    if (entry.modelSelectionLocked !== true) {
      return undefined;
    }
    const pluginOwnerId = normalizeOptionalString(entry.pluginOwnerId);
    if (pluginOwnerId) {
      if (isAgentHarnessSessionKey(sessionKey)) {
        throw new Error(
          `Locked session "${sessionKey}" mixes plugin and reserved harness ownership.`,
        );
      }
      return { ownerPluginId: pluginOwnerId };
    }
    const { harnessId, registration } = requireHarnessRegistration(
      resolveSessionPinnedHarnessId(entry),
      `${action} locked sessions`,
    );
    if (
      isAgentHarnessSessionKey(sessionKey) &&
      !isAgentHarnessSessionKeyOwnedBy(sessionKey, harnessId)
    ) {
      throw new Error(
        `Locked session "${sessionKey}" belongs to agent harness "${harnessId}", which does not match its reserved session key.`,
      );
    }
    return { ownerPluginId: registration.pluginId, harnessId, registration };
  };
  const assertLockedSessionEntryOwned = (
    sessionKey: string,
    entry: SessionOwnershipFields,
    action: string,
  ): void => {
    const resolved = resolveLockedSessionHarnessRegistration(sessionKey, entry, action);
    if (!resolved) {
      return;
    }
    if (resolved.ownerPluginId !== pluginId) {
      throw new Error(
        `Locked session "${sessionKey}" is owned by plugin "${resolved.ownerPluginId}", not "${pluginId}".`,
      );
    }
  };
  const assertSessionEntryOwned = (params: {
    action: string;
    entry?: SessionEntry;
    sessionKey: string;
  }): void => {
    if (params.entry) {
      // Before harness locking shipped, plugins could create ordinary sessions
      // whose user-chosen key happened to start with `harness:`.
      assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
      return;
    }
    assertReservedSessionKeyOwned(params.sessionKey, params.action);
  };
  return {
    assertOwnedHarness,
    assertReservedSessionKeyOwned,
    resolveLockedSessionHarnessRegistration,
    assertLockedSessionEntryOwned,
    assertSessionEntryOwned,
  };
}
