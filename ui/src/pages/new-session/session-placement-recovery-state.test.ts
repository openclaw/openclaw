import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import {
  PendingSessionPlacementRecoveryState,
  resolveSubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";

const gatewayUrl = "ws://gateway.example";
const recoveryScope = "principal-a";
const canonicalSessionKey = "agent:cloud:dashboard:server-key";
const exactKey = (key: string) =>
  sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, key);
const readRecovery = (key: string) => readSessionPlacementRecovery(gatewayUrl, recoveryScope, key);

function interceptWrites(setItem: (key: string, value: string) => void) {
  const storage = sessionStorage;
  vi.stubGlobal("sessionStorage", {
    get length() {
      return storage.length;
    },
    getItem: storage.getItem.bind(storage),
    key: storage.key.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem,
  });
}

function stageCreate(
  pending: PendingSessionPlacementRecoveryState,
  overrides: Partial<Parameters<PendingSessionPlacementRecoveryState["stageCreate"]>[0]> = {},
) {
  return pending.stageCreate({
    agentId: "cloud",
    target: { kind: "profile", profileId: "aws" },
    message: "run remotely",
    gatewayUrl,
    recoveryScope,
    createParams: { agentId: "cloud", message: "", worktree: true },
    ...overrides,
  });
}

describe("pending session placement recovery state", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("does not restore a creating draft owned by another mounted surface", () => {
    const context = {};
    const palette = new PendingSessionPlacementRecoveryState(() => context);
    const page = new PendingSessionPlacementRecoveryState(() => context);
    expect(stageCreate(palette, { message: "palette task" })).not.toBeNull();
    expect(page.restore(gatewayUrl, recoveryScope)).toBeNull();
    expect(palette.restore(gatewayUrl, recoveryScope)?.message).toBe("palette task");
    palette.releaseClaim();
    expect(page.restore(gatewayUrl, recoveryScope)?.message).toBe("palette task");
    expect(palette.hasOtherLiveOwner(gatewayUrl, recoveryScope, palette.sessionKey)).toBe(true);
    expect(palette.owns(gatewayUrl, recoveryScope, palette.sessionKey)).toBe(false);
    page.clear();
  });

  it.each([
    [false, "gateway-changed"],
    [true, "placement-interrupted"],
  ] as const)("classifies placement ownership %s as %s", (placementDraftOwned, expected) => {
    expect(
      resolveSubmissionOutcomeReason({ gatewayIdentityChanged: false, placementDraftOwned }),
    ).toBe(expected);
  });

  it("preserves permissions, runtime and explicit names through staging, storage, and capture", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    const expected = {
      permissionMode: "guarded" as const,
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
      displayName: "Repair naming",
      worktreeName: "my-explicit-branch",
    };
    const createParams = stageCreate(pending, {
      target: { kind: "auto-device" },
      attachments: [{ type: "image" }],
      createParams: { agentId: "cloud", message: "", worktree: true, ...expected },
    });
    expect(createParams).toMatchObject(expected);
    const snapshot = {
      phase: "creating",
      message: "run remotely",
      createParams: { ...createParams, ...expected, key: pending.sessionKey },
    };
    expect(readRecovery(pending.sessionKey)).toMatchObject(snapshot);
    expect(pending.capture()).toMatchObject(snapshot);
  });

  it.each([false, true])(
    "does not promote over a replacement submission (canonical key changes: %s)",
    (changesKey) => {
      const pending = new PendingSessionPlacementRecoveryState();
      expect(stageCreate(pending, { message: "old input" })).not.toBeNull();
      const previous = pending.capture();
      expect(previous).not.toBeNull();
      const replacement = { ...previous!, messageId: "new-submission", message: "new input" };
      expect(writeSessionPlacementRecovery(replacement)).toBe(true);
      expect(
        pending.promoteToDispatching(changesKey ? "agent:cloud:canonical" : pending.sessionKey),
      ).toBe(false);
      expect(readRecovery(pending.sessionKey)).toEqual(replacement);
    },
  );

  it.each([{ os: "x".repeat(65) }])("rejects invalid persisted placement options %#", (options) => {
    expect(
      writeSessionPlacementRecovery({
        sessionKey: "agent:cloud:invalid-machine",
        messageId: "message-invalid-machine",
        message: "run remotely",
        target: { kind: "profile", profileId: "aws", ...options },
        agentId: "cloud",
        gatewayUrl,
        recoveryScope,
        phase: "dispatching",
      }),
    ).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it.each(["success", "before-write", "after-write"] as const)(
    "promotes the canonical key atomically (%s)",
    (outcome) => {
      const pending = new PendingSessionPlacementRecoveryState();
      expect(stageCreate(pending)).not.toBeNull();
      const storage = sessionStorage;
      const provisionalSessionKey = pending.sessionKey;
      const provisionalKey = exactKey(provisionalSessionKey);
      const canonicalKey = exactKey(canonicalSessionKey);
      const raw = storage.getItem(provisionalKey);
      interceptWrites((key, value) => {
        if (
          key === canonicalKey &&
          (outcome !== "success" || storage.getItem(provisionalKey) !== null)
        ) {
          if (outcome === "after-write") {
            storage.setItem(key, value);
          }
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      });
      expect(pending.promoteToDispatching(canonicalSessionKey)).toBe(outcome === "success");
      if (outcome === "success") {
        expect(readRecovery(provisionalSessionKey)).toBeNull();
        expect(readRecovery(canonicalSessionKey)).toMatchObject({
          phase: "dispatching",
          sessionKey: canonicalSessionKey,
        });
        expect(pending.createParams).toBeUndefined();
      } else {
        expect(storage.getItem(provisionalKey)).toBe(raw);
        expect(storage.getItem(canonicalKey)).toBeNull();
        expect(pending.sessionKey).toBe(provisionalSessionKey);
      }
    },
  );

  it("keeps incognito placement drafts in memory without writing recovery storage", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    const createParams = stageCreate(pending, {
      message: "private remote task",
      createParams: {
        agentId: "cloud",
        incognito: true,
        fastMode: true,
        message: "",
        worktree: true,
      },
      persistent: false,
    });

    expect(createParams).toMatchObject({
      agentId: "cloud",
      incognito: true,
      fastMode: true,
      worktree: true,
    });
    expect(createParams).not.toHaveProperty("key");
    expect(pending.persistent).toBe(false);
    expect(readRecovery(pending.sessionKey)).toBeNull();
    expect(pending.promoteToDispatching(canonicalSessionKey)).toBe(true);
    expect(pending.sessionKey).toBe(canonicalSessionKey);
    expect(readRecovery(canonicalSessionKey)).toBeNull();
  });
});
