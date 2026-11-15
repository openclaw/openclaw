import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  clearSessionPlacementRecovery,
  listSessionPlacementRecoveries,
  migrateSessionPlacementRecoveryScope,
  pauseSessionPlacementRecovery,
  promoteSessionPlacementRecovery,
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
  writeSessionPlacementRecoveryIfAvailable,
} from "../../lib/sessions/session-placement-recovery.ts";

const recovery = {
  sessionKey: "agent:cloud:one",
  messageId: "message-1",
  message: "run remotely",
  target: { kind: "profile" as const, profileId: "aws" },
  agentId: "cloud",
  gatewayUrl: "ws://gateway.example",
  recoveryScope: "principal-a",
  phase: "dispatching" as const,
};

const exactKey = (sessionKey: string) =>
  sessionPlacementRecoveryExactStorageKey(recovery.gatewayUrl, recovery.recoveryScope, sessionKey);

const readRecovery = (
  record: Pick<typeof recovery, "gatewayUrl" | "recoveryScope" | "sessionKey"> = recovery,
) => readSessionPlacementRecovery(record.gatewayUrl, record.recoveryScope, record.sessionKey);

describe("session placement recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("frames every namespace component without URI encoding", () => {
    const gatewayUrl = "ws://gateway.example";
    const recoveryScope = "principal-a";
    const sessionKey = "admin";
    const scopePrefix = `openclaw.new-session.session-placement-recovery.v1:${gatewayUrl.length}:${gatewayUrl}:${recoveryScope.length}:${recoveryScope}:`;
    expect(sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, sessionKey)).toBe(
      `${scopePrefix}${sessionKey.length}:${sessionKey}`,
    );
    const colonGateway = `${gatewayUrl}:principal-a`;
    expect(sessionPlacementRecoveryExactStorageKey(colonGateway, "admin", sessionKey)).not.toBe(
      sessionPlacementRecoveryExactStorageKey(gatewayUrl, "principal-a:admin", sessionKey),
    );

    expect(sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, "\ud800")).not.toBe(
      sessionPlacementRecoveryExactStorageKey(gatewayUrl, recoveryScope, "\ud801"),
    );
  });

  it("keeps required input outside the released scope through promotion, migration, and retirement", () => {
    const required = {
      ...recovery,
      target: { kind: "profile" as const, profileId: "aws", required: true as const },
      attachments: [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }],
    };
    const optional = {
      ...recovery,
      sessionKey: "agent:cloud:optional",
      messageId: "optional-turn",
    };
    expect(writeSessionPlacementRecovery(required)).toBe(true);
    expect(writeSessionPlacementRecovery(optional)).toBe(true);
    const releasedPrefix = `openclaw.new-session.session-placement-recovery.v1:${recovery.gatewayUrl.length}:${recovery.gatewayUrl}:${recovery.recoveryScope.length}:${recovery.recoveryScope}:`;
    const storedKeys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)!,
    );
    expect(storedKeys.filter((key) => key.startsWith(releasedPrefix))).toEqual([
      exactKey(optional.sessionKey),
    ]);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      required,
      optional,
    ]);

    const promoted = { ...required, sessionKey: "agent:cloud:canonical" };
    expect(promoteSessionPlacementRecovery(required.sessionKey, promoted)).toBe(true);
    expect(readRecovery()).toBeNull();
    expect(readRecovery(promoted)).toEqual(promoted);
    const paused = pauseSessionPlacementRecovery(promoted, "placement unavailable", true).recovery;
    const destinationScope = "principal-migrated";
    migrateSessionPlacementRecoveryScope(
      recovery.gatewayUrl,
      recovery.recoveryScope,
      destinationScope,
    );
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([]);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, destinationScope)).toEqual([
      { ...paused, recoveryScope: destinationScope },
      { ...optional, recoveryScope: destinationScope },
    ]);
    clearSessionPlacementRecovery(
      recovery.gatewayUrl,
      destinationScope,
      promoted.sessionKey,
      "older-turn",
    );
    expect(readRecovery({ ...promoted, recoveryScope: destinationScope })).toEqual({
      ...paused,
      recoveryScope: destinationScope,
    });
    clearSessionPlacementRecovery(recovery.gatewayUrl, destinationScope);
    expect(sessionStorage.length).toBe(0);
  });

  it("relocates a required draft written before namespace isolation without replacing newer input", () => {
    const required = {
      ...recovery,
      target: { kind: "profile" as const, profileId: "aws", required: true as const },
    };
    sessionStorage.setItem(exactKey(required.sessionKey), JSON.stringify(required));
    expect(readRecovery()).toEqual(required);
    expect(sessionStorage.getItem(exactKey(required.sessionKey))).toBeNull();
    const older = { ...required, messageId: "older-turn", message: "older input" };
    const olderRaw = JSON.stringify(older);
    sessionStorage.setItem(exactKey(required.sessionKey), olderRaw);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope)).toEqual([
      required,
    ]);
    expect(sessionStorage.getItem(exactKey(required.sessionKey))).toBe(olderRaw);
    expect(writeSessionPlacementRecoveryIfAvailable({ ...older, message: "do not replace" })).toBe(
      false,
    );
    clearSessionPlacementRecovery(recovery.gatewayUrl, recovery.recoveryScope);
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps input in memory on a failed pause write (already paused=true)", () => {
    const retained = {
      ...recovery,
      phase: "paused" as const,
      reason: "not-sent" as const,
      error: "first failure",
    };
    expect(writeSessionPlacementRecovery(retained)).toBe(true);
    const storage = sessionStorage;
    vi.stubGlobal("sessionStorage", {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
    });
    expect(pauseSessionPlacementRecovery(retained, "later failure", true)).toMatchObject({
      persisted: false,
      recovery: {
        message: retained.message,
        messageId: retained.messageId,
        phase: "paused",
        reason: "not-sent",
        error: expect.stringContaining("Keep this page open"),
      },
    });
    expect(readRecovery()).toEqual(retained);
  });

  it("keeps bounded pause errors on UTF-16 boundaries (persistent=false)", () => {
    const error = `${"x".repeat(4095)}🤖`;
    const paused = pauseSessionPlacementRecovery(recovery, error, false);

    expect(paused.recovery.error).toBe("x".repeat(4095));
    expect(paused.persisted).toBe(false);
    expect(readRecovery()).toEqual(null);
  });

  it("keeps storage-failure guidance on UTF-16 boundaries", () => {
    const prefix = "Recovery could not be saved in this tab. Keep this page open.\n";
    const error = `${"x".repeat(4095 - prefix.length)}🤖`;
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    const storage = sessionStorage;
    vi.stubGlobal("sessionStorage", {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
    });

    const paused = pauseSessionPlacementRecovery(recovery, error, true);

    expect(paused.recovery.error).toBe(`${prefix}${"x".repeat(4095 - prefix.length)}`);
    expect(paused.persisted).toBe(false);
    expect(readRecovery()).toBeNull();
  });

  it("migrates only exact framed rows under a new scope", () => {
    const sourceScope = recovery.recoveryScope;
    const newScope = "gateway-principal";
    const second = {
      ...recovery,
      sessionKey: "agent:cloud:two",
      messageId: "message-2",
    };
    const unrelatedScope = { ...recovery, recoveryScope: "principal-other" };
    const unrelatedGateway = { ...recovery, gatewayUrl: "ws://other.example" };
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    expect(writeSessionPlacementRecovery(second)).toBe(true);
    expect(writeSessionPlacementRecovery(unrelatedScope)).toBe(true);
    expect(writeSessionPlacementRecovery(unrelatedGateway)).toBe(true);

    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, sourceScope, newScope);

    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, newScope)).toEqual([
      { ...recovery, recoveryScope: newScope },
      { ...second, recoveryScope: newScope },
    ]);
    expect(listSessionPlacementRecoveries(recovery.gatewayUrl, sourceScope)).toEqual([]);
    expect(
      listSessionPlacementRecoveries(unrelatedScope.gatewayUrl, unrelatedScope.recoveryScope),
    ).toEqual([unrelatedScope]);
    expect(listSessionPlacementRecoveries(unrelatedGateway.gatewayUrl, sourceScope)).toEqual([
      unrelatedGateway,
    ]);
  });

  it("preserves source bytes on destination collision, write failure, and clear failure", () => {
    const newScope = "gateway-principal";
    const sourceRaw = ` ${JSON.stringify(recovery)}\n`;
    const sourceKey = exactKey(recovery.sessionKey);
    const destination = {
      ...recovery,
      messageId: "message-destination",
      message: "keep the destination task",
      recoveryScope: newScope,
    };
    const destinationKey = sessionPlacementRecoveryExactStorageKey(
      recovery.gatewayUrl,
      newScope,
      recovery.sessionKey,
    );
    sessionStorage.setItem(sourceKey, sourceRaw);
    expect(writeSessionPlacementRecovery(destination)).toBe(true);

    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(sessionStorage.getItem(sourceKey)).toBe(sourceRaw);
    expect(
      readSessionPlacementRecovery(recovery.gatewayUrl, newScope, recovery.sessionKey),
    ).toEqual(destination);

    sessionStorage.removeItem(destinationKey);
    const storage = sessionStorage;
    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: vi.fn((key: string, value: string) => {
        if (key === destinationKey) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      }),
    });
    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(storage.getItem(sourceKey)).toBe(sourceRaw);
    expect(storage.getItem(destinationKey)).toBeNull();

    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: vi.fn((key: string) => {
        if (key === sourceKey) {
          throw new DOMException("storage disabled", "SecurityError");
        }
        storage.removeItem(key);
      }),
      setItem: storage.setItem.bind(storage),
    });
    migrateSessionPlacementRecoveryScope(recovery.gatewayUrl, recovery.recoveryScope, newScope);
    expect(storage.getItem(sourceKey)).toBe(sourceRaw);
    expect(
      readSessionPlacementRecovery(recovery.gatewayUrl, newScope, recovery.sessionKey),
    ).toEqual({
      ...recovery,
      recoveryScope: newScope,
    });
  });

  it("removes only hostile v2 rows while preserving valid siblings", () => {
    const surrogateRecovery = {
      ...recovery,
      sessionKey: "\ud800",
      messageId: "message-surrogate",
    };
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
    expect(writeSessionPlacementRecovery(surrogateRecovery)).toBe(true);
    sessionStorage.setItem(
      exactKey("agent:cloud:incognito"),
      JSON.stringify({ ...recovery, createParams: { incognito: true } }),
    );
    sessionStorage.setItem(
      exactKey("agent:cloud:wrong-key"),
      JSON.stringify({ ...recovery, messageId: "message-valid" }),
    );
    const invalidPayload = {
      ...recovery,
      sessionKey: "agent:cloud:invalid-payload",
      messageId: "",
    };
    sessionStorage.setItem(exactKey(invalidPayload.sessionKey), JSON.stringify(invalidPayload));
    const malformedKey = exactKey("\ud801");
    sessionStorage.setItem(malformedKey, "{not-json");

    const listed = listSessionPlacementRecoveries(recovery.gatewayUrl, recovery.recoveryScope);
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([recovery, surrogateRecovery]));
    expect(sessionStorage.getItem(exactKey(recovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey(surrogateRecovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:incognito"))).toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:wrong-key"))).toBeNull();
    expect(sessionStorage.getItem(exactKey(invalidPayload.sessionKey))).toBeNull();
    expect(sessionStorage.getItem(malformedKey)).toBeNull();
  });

  it("round-trips a device folder only with its exact dispatch target", () => {
    const creating = {
      ...recovery,
      phase: "creating" as const,
      target: { kind: "device" as const, deviceId: "runner" },
      createParams: {
        key: recovery.sessionKey,
        agentId: "cloud",
        message: "" as const,
        deviceFolder: { deviceId: "runner", path: "/srv/project" },
      },
    };
    expect(writeSessionPlacementRecovery(creating)).toBe(true);
    expect(readRecovery()).toEqual(creating);
    expect(writeSessionPlacementRecovery({ ...creating, target: { kind: "auto-device" } })).toBe(
      false,
    );
    expect(
      writeSessionPlacementRecovery({ ...creating, target: { kind: "device", deviceId: "other" } }),
    ).toBe(false);
  });

  it("rejects a malformed persisted device-folder binding", () => {
    sessionStorage.setItem(
      exactKey(recovery.sessionKey),
      JSON.stringify({
        ...recovery,
        phase: "creating",
        target: { kind: "device", deviceId: "runner" },
        createParams: {
          key: recovery.sessionKey,
          agentId: "cloud",
          message: "",
          deviceFolder: null,
        },
      }),
    );
    expect(readRecovery()).toBeNull();
  });

  it("round-trips an attachment-only first turn", () => {
    const attachmentRecovery = {
      ...recovery,
      message: "",
      attachments: [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }],
    };
    expect(writeSessionPlacementRecovery(attachmentRecovery)).toBe(true);
    expect(readRecovery()).toEqual(attachmentRecovery);
  });

  it.each([
    { projectId: "openclaw", worktree: true as const },
    { repository: { url: "https://github.com/openclaw/openclaw.git", ref: "release/next" } },
  ])("requires matching create parameters for a creating recovery: %j", (workspace) => {
    const creating = {
      ...recovery,
      phase: "creating" as const,
      createParams: {
        key: recovery.sessionKey,
        agentId: "cloud",
        message: "" as const,
        category: "Client work",
        model: "openai/gpt-5.6-sol",
        agentRuntime: "codex",
        thinkingLevel: "high",
        toolOverrides: {
          mcpServers: { github: false },
          skills: { release: false },
          webSearch: false,
        },
        visibility: "draft" as const,
        ...workspace,
      },
    };
    expect(writeSessionPlacementRecovery(creating)).toBe(true);
    expect(readRecovery()).toEqual(creating);

    sessionStorage.setItem(
      exactKey(recovery.sessionKey),
      JSON.stringify({ ...creating, createParams: { key: "agent:cloud:other" } }),
    );
    expect(readRecovery()).toBeNull();
  });
});
