import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import {
  PendingSessionPlacementRecoveryState,
  resolveSubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";

function stageCreate(
  pending: PendingSessionPlacementRecoveryState,
  overrides: Partial<Parameters<PendingSessionPlacementRecoveryState["stageCreate"]>[0]> = {},
) {
  return pending.stageCreate({
    agentId: "cloud",
    target: { kind: "profile", profileId: "aws" },
    message: "run remotely",
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal-a",
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
    const request = palette.stageCreate({
      agentId: "main",
      target: { kind: "device", deviceId: "runner" },
      message: "palette task",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams: { agentId: "main", message: "", worktree: true, worktreeSource: "empty" },
    });
    expect(request).not.toBeNull();
    expect(page.restore("ws://gateway.example", "principal-a")).toBeNull();
    expect(palette.restore("ws://gateway.example", "principal-a")?.message).toBe("palette task");
    palette.releaseClaim();
    expect(page.restore("ws://gateway.example", "principal-a")?.message).toBe("palette task");
    expect(
      palette.hasOtherLiveOwner("ws://gateway.example", "principal-a", palette.sessionKey),
    ).toBe(true);
    expect(palette.owns("ws://gateway.example", "principal-a", palette.sessionKey)).toBe(false);
    page.clear();
  });

  it.each([
    {
      name: "a normal local submission",
      gatewayIdentityChanged: false,
      placementDraftOwned: false,
      expected: "gateway-changed",
    },
    {
      name: "an interrupted placement draft",
      gatewayIdentityChanged: false,
      placementDraftOwned: true,
      expected: "placement-interrupted",
    },
  ])("classifies $name accurately", ({ expected, gatewayIdentityChanged, placementDraftOwned }) => {
    expect(resolveSubmissionOutcomeReason({ gatewayIdentityChanged, placementDraftOwned })).toBe(
      expected,
    );
  });

  it("preserves the requested permission mode in placement recovery", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    const createParams = stageCreate(pending, {
      message: "run remotely with guarded permissions",
      createParams: {
        agentId: "cloud",
        message: "",
        permissionMode: "guarded",
        worktree: true,
      },
    });

    expect(createParams).toMatchObject({ permissionMode: "guarded" });
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toMatchObject({ createParams: { permissionMode: "guarded" } });
  });

  it.each(["codex"])("preserves draft model and runtime %s through recovery", (agentRuntime) => {
    const pending = new PendingSessionPlacementRecoveryState();
    const createParams = stageCreate(pending, {
      target: { kind: "auto-device" },
      createParams: buildDraftSessionCreateParams({
        agentId: "cloud",
        message: "keep the selected runtime",
        deferInitialTurn: true,
        model: "openai/gpt-5.6-sol",
        agentRuntime,
        worktree: true,
      }),
    });

    expect(createParams).not.toBeNull();
    expect(createParams?.model).toBe("openai/gpt-5.6-sol");
    expect(createParams?.agentRuntime).toBe(agentRuntime);
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toMatchObject({ phase: "creating", createParams, message: "run remotely" });
  });

  it.each([false, true])(
    "does not promote over a replacement submission (canonical key changes: %s)",
    (changesKey) => {
      const pending = new PendingSessionPlacementRecoveryState();
      expect(
        stageCreate(pending, {
          target: { kind: "device", deviceId: "device-1" },
          message: "old input",
        }),
      ).not.toBeNull();
      const previous = pending.capture();
      expect(previous).not.toBeNull();
      const replacement = { ...previous!, messageId: "new-submission", message: "new input" };
      expect(writeSessionPlacementRecovery(replacement)).toBe(true);
      expect(
        pending.promoteToDispatching(changesKey ? "agent:cloud:canonical" : pending.sessionKey),
      ).toBe(false);
      expect(
        readSessionPlacementRecovery(pending.gatewayUrl, pending.recoveryScope, pending.sessionKey),
      ).toEqual(replacement);
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
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    ).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it("promotes the acknowledged server key before dispatch", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    expect(stageCreate(pending)).not.toBeNull();
    const provisionalSessionKey = pending.sessionKey;
    const storage = sessionStorage;
    const provisionalKey = sessionPlacementRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      provisionalSessionKey,
    );
    const canonicalKey = sessionPlacementRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      "agent:cloud:dashboard:server-key",
    );
    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem(key: string, value: string) {
        if (key === canonicalKey && storage.getItem(provisionalKey) !== null) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      },
    });

    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", provisionalSessionKey),
    ).toBeNull();
    expect(
      readSessionPlacementRecovery(
        "ws://gateway.example",
        "principal-a",
        "agent:cloud:dashboard:server-key",
      ),
    ).toMatchObject({
      phase: "dispatching",
      sessionKey: "agent:cloud:dashboard:server-key",
    });
    expect(pending.createParams).toBeUndefined();
  });

  it.each([false, true])(
    "restores the provisional row when canonical promotion throws (committed=%s)",
    (committed) => {
      const pending = new PendingSessionPlacementRecoveryState();
      expect(stageCreate(pending)).not.toBeNull();
      const storage = sessionStorage;
      const provisionalSessionKey = pending.sessionKey;
      const provisionalKey = sessionPlacementRecoveryExactStorageKey(
        "ws://gateway.example",
        "principal-a",
        provisionalSessionKey,
      );
      const canonicalSessionKey = "agent:cloud:dashboard:server-key";
      const canonicalKey = sessionPlacementRecoveryExactStorageKey(
        "ws://gateway.example",
        "principal-a",
        canonicalSessionKey,
      );
      const raw = storage.getItem(provisionalKey);
      vi.stubGlobal("sessionStorage", {
        get length() {
          return storage.length;
        },
        getItem: storage.getItem.bind(storage),
        key: storage.key.bind(storage),
        removeItem: storage.removeItem.bind(storage),
        setItem(key: string, value: string) {
          if (key === canonicalKey) {
            if (committed) {
              storage.setItem(key, value);
            }
            throw new DOMException("quota exceeded", "QuotaExceededError");
          }
          storage.setItem(key, value);
        },
      });

      expect(pending.promoteToDispatching(canonicalSessionKey)).toBe(false);
      expect(storage.getItem(provisionalKey)).toBe(raw);
      expect(storage.getItem(canonicalKey)).toBeNull();
      expect(pending.sessionKey).toBe(provisionalSessionKey);
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
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toBeNull();
    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(pending.sessionKey).toBe("agent:cloud:dashboard:server-key");
    expect(
      readSessionPlacementRecovery(
        "ws://gateway.example",
        "principal-a",
        "agent:cloud:dashboard:server-key",
      ),
    ).toBeNull();
  });

  it("captures named creating recovery without sharing mutable payloads", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    expect(
      stageCreate(pending, {
        attachments: [{ type: "image" }],
        createParams: {
          agentId: "cloud",
          message: "",
          displayName: "Repair naming",
          worktreeName: "my-explicit-branch",
          worktree: true,
        },
      }),
    ).not.toBeNull();

    const captured = pending.capture();
    expect(captured).toMatchObject({
      phase: "creating",
      message: "run remotely",
      createParams: {
        key: pending.sessionKey,
        displayName: "Repair naming",
        worktreeName: "my-explicit-branch",
      },
    });
    expect(captured?.attachments).not.toBe(pending.attachments);
    expect(captured?.createParams).not.toBe(pending.createParams);
  });
});
