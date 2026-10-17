import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  clearSessionPlacementRecovery as clearRecovery,
  listSessionPlacementRecoveries as listForScope,
  migrateSessionPlacementRecoveryScope as migrateScope,
  pauseSessionPlacementRecovery as pause,
  promoteSessionPlacementRecovery as promote,
  readSessionPlacementRecovery as read,
  writeSessionPlacementRecovery as write,
  writeSessionPlacementRecoveryIfAvailable as writeIfAvailable,
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

const url = recovery.gatewayUrl;
const scope = recovery.recoveryScope;
const scopePrefix = `openclaw.new-session.session-placement-recovery.v1:${url.length}:${url}:${scope.length}:${scope}:`;
const required = {
  ...recovery,
  target: { ...recovery.target, required: true as const },
};
const attachments = [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }];
const exactKey = (sessionKey: string) =>
  sessionPlacementRecoveryExactStorageKey(url, scope, sessionKey);

const readRecovery = (
  record: Pick<typeof recovery, "gatewayUrl" | "recoveryScope" | "sessionKey"> = recovery,
) => read(record.gatewayUrl, record.recoveryScope, record.sessionKey);

const listRecoveries = (principal = scope) => listForScope(url, principal);
const migrate = (principal: string) => migrateScope(url, scope, principal);
function writeRaw(sessionKey: string, record: unknown) {
  sessionStorage.setItem(exactKey(sessionKey), JSON.stringify(record));
}
function makeCreating<T extends object>(createParams: T) {
  return {
    ...recovery,
    phase: "creating" as const,
    createParams: {
      key: recovery.sessionKey,
      agentId: "cloud",
      message: "" as const,
      ...createParams,
    },
  };
}

function interceptStorage(writeKey?: string | true, clearKey?: string) {
  const storage = sessionStorage;
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
    if (this === storage && key === clearKey) {
      throw new DOMException("storage disabled", "SecurityError");
    }
    removeItem.call(this, key);
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (this === storage && (writeKey === true || key === writeKey)) {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }
    setItem.call(this, key, value);
  });
}

describe("session placement recovery", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("frames every namespace component without URI encoding", () => {
    const sessionKey = "admin";
    expect(exactKey(sessionKey)).toBe(`${scopePrefix}${sessionKey.length}:${sessionKey}`);
    expect(
      sessionPlacementRecoveryExactStorageKey(`${url}:principal-a`, "admin", sessionKey),
    ).not.toBe(sessionPlacementRecoveryExactStorageKey(url, "principal-a:admin", sessionKey));
    expect(exactKey("\ud800")).not.toBe(exactKey("\ud801"));
  });

  it("keeps required input outside the released scope through promotion, migration, and retirement", () => {
    const requiredInput = { ...required, attachments };
    const optional = {
      ...recovery,
      sessionKey: "agent:cloud:optional",
      messageId: "optional-turn",
    };
    expect(write(requiredInput)).toBe(true);
    expect(write(optional)).toBe(true);
    const storedKeys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)!,
    );
    expect(storedKeys.filter((key) => key.startsWith(scopePrefix))).toEqual([
      exactKey(optional.sessionKey),
    ]);
    expect(listRecoveries()).toEqual([requiredInput, optional]);

    const promoted = { ...requiredInput, sessionKey: "agent:cloud:canonical" };
    expect(promote(required.sessionKey, promoted)).toBe(true);
    expect(readRecovery()).toBeNull();
    expect(readRecovery(promoted)).toEqual(promoted);
    const paused = pause(promoted, "placement unavailable", true).recovery;
    const destinationScope = "principal-migrated";
    migrate(destinationScope);
    expect(listRecoveries()).toEqual([]);
    expect(listRecoveries(destinationScope)).toEqual([
      { ...paused, recoveryScope: destinationScope },
      { ...optional, recoveryScope: destinationScope },
    ]);
    clearRecovery(url, destinationScope, promoted.sessionKey, "older-turn");
    expect(readRecovery({ ...promoted, recoveryScope: destinationScope })).toEqual({
      ...paused,
      recoveryScope: destinationScope,
    });
    clearRecovery(url, destinationScope);
    expect(sessionStorage.length).toBe(0);
  });

  it("relocates a required draft written before namespace isolation without replacing newer input", () => {
    writeRaw(required.sessionKey, required);
    expect(readRecovery()).toEqual(required);
    expect(sessionStorage.getItem(exactKey(required.sessionKey))).toBeNull();
    const older = { ...required, messageId: "older-turn", message: "older input" };
    const olderRaw = JSON.stringify(older);
    sessionStorage.setItem(exactKey(required.sessionKey), olderRaw);
    expect(listRecoveries()).toEqual([required]);
    expect(sessionStorage.getItem(exactKey(required.sessionKey))).toBe(olderRaw);
    expect(writeIfAvailable({ ...older, message: "do not replace" })).toBe(false);
    clearRecovery(url, scope);
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps already-paused input in memory on a failed pause write", () => {
    const retained = {
      ...recovery,
      phase: "paused" as const,
      reason: "not-sent" as const,
      error: "first failure",
    };
    expect(write(retained)).toBe(true);
    interceptStorage(true);
    expect(pause(retained, "later failure", true)).toMatchObject({
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

  it.each([false, true])("bounds UTF-16 pause errors (failed persistence=%s)", (persistent) => {
    const prefix = persistent
      ? "Recovery could not be saved in this tab. Keep this page open.\n"
      : "";
    const error = "x".repeat(4095 - prefix.length) + "🤖";
    if (persistent) {
      expect(write(recovery)).toBe(true);
      interceptStorage(true);
    }
    const paused = pause(recovery, error, persistent);
    expect(paused.recovery.error).toBe(prefix + "x".repeat(4095 - prefix.length));
    expect(paused.persisted).toBe(false);
    expect(readRecovery()).toBeNull();
  });

  it("migrates only exact framed rows under a new scope", () => {
    const newScope = "gateway-principal";
    const second = { ...recovery, sessionKey: "agent:cloud:two", messageId: "message-2" };
    const unrelatedScope = { ...recovery, recoveryScope: "principal-other" };
    const unrelatedGateway = { ...recovery, gatewayUrl: "ws://other.example" };
    expect(write(recovery)).toBe(true);
    expect(write(second)).toBe(true);
    expect(write(unrelatedScope)).toBe(true);
    expect(write(unrelatedGateway)).toBe(true);

    migrate(newScope);

    expect(listRecoveries(newScope)).toEqual([
      { ...recovery, recoveryScope: newScope },
      { ...second, recoveryScope: newScope },
    ]);
    expect(listRecoveries()).toEqual([]);
    expect(listForScope(unrelatedScope.gatewayUrl, unrelatedScope.recoveryScope)).toEqual([
      unrelatedScope,
    ]);
    expect(listForScope(unrelatedGateway.gatewayUrl, scope)).toEqual([unrelatedGateway]);
  });

  it.each(["collision", "write", "clear"])(
    "preserves source bytes on migration %s failure",
    (failure) => {
      const newScope = "gateway-principal";
      const sourceRaw = ` ${JSON.stringify(recovery)}\n`;
      const sourceKey = exactKey(recovery.sessionKey);
      const destination = {
        ...recovery,
        recoveryScope: newScope,
        ...(failure === "collision"
          ? { messageId: "message-destination", message: "keep the destination task" }
          : {}),
      };
      const destinationKey = sessionPlacementRecoveryExactStorageKey(
        url,
        newScope,
        recovery.sessionKey,
      );
      const storage = sessionStorage;
      storage.setItem(sourceKey, sourceRaw);
      if (failure === "collision") {
        expect(write(destination)).toBe(true);
      } else {
        interceptStorage(
          failure === "write" ? destinationKey : undefined,
          failure === "clear" ? sourceKey : undefined,
        );
      }
      migrate(newScope);
      expect(storage.getItem(sourceKey)).toBe(sourceRaw);
      if (failure === "write") {
        expect(storage.getItem(destinationKey)).toBeNull();
      } else {
        expect(readRecovery(destination)).toEqual(destination);
      }
    },
  );

  it("removes only hostile v2 rows while preserving valid siblings", () => {
    const surrogateRecovery = { ...recovery, sessionKey: "\ud800", messageId: "message-surrogate" };
    expect(write(recovery)).toBe(true);
    expect(write(surrogateRecovery)).toBe(true);
    writeRaw("agent:cloud:incognito", { ...recovery, createParams: { incognito: true } });
    writeRaw("agent:cloud:wrong-key", { ...recovery, messageId: "message-valid" });
    const invalidKey = "agent:cloud:invalid-payload";
    writeRaw(invalidKey, { ...recovery, sessionKey: invalidKey, messageId: "" });
    const malformedKey = exactKey("\ud801");
    sessionStorage.setItem(malformedKey, "{not-json");

    const listed = listRecoveries();
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([recovery, surrogateRecovery]));
    expect(sessionStorage.getItem(exactKey(recovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey(surrogateRecovery.sessionKey))).not.toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:incognito"))).toBeNull();
    expect(sessionStorage.getItem(exactKey("agent:cloud:wrong-key"))).toBeNull();
    expect(sessionStorage.getItem(exactKey(invalidKey))).toBeNull();
    expect(sessionStorage.getItem(malformedKey)).toBeNull();
  });

  it("round-trips a device folder only with its exact dispatch target", () => {
    const creating = {
      ...makeCreating({ deviceFolder: { deviceId: "runner", path: "/srv/project" } }),
      target: { kind: "device" as const, deviceId: "runner" },
    };
    expect(write(creating)).toBe(true);
    expect(readRecovery()).toEqual(creating);
    expect(write({ ...creating, target: { kind: "auto-device" } })).toBe(false);
    expect(write({ ...creating, target: { kind: "device", deviceId: "other" } })).toBe(false);
  });

  it("rejects a malformed persisted device-folder binding", () => {
    writeRaw(recovery.sessionKey, {
      ...makeCreating({ deviceFolder: null }),
      target: { kind: "device", deviceId: "runner" },
    });
    expect(readRecovery()).toBeNull();
  });

  it("round-trips an attachment-only first turn", () => {
    const attachmentRecovery = { ...recovery, message: "", attachments };
    expect(write(attachmentRecovery)).toBe(true);
    expect(readRecovery()).toEqual(attachmentRecovery);
  });

  it.each([
    { projectId: "openclaw", worktree: true as const },
    { repository: { url: "https://github.com/openclaw/openclaw.git", ref: "release/next" } },
  ])("requires matching create parameters for a creating recovery: %j", (workspace) => {
    const creating = makeCreating({
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
    });
    expect(write(creating)).toBe(true);
    expect(readRecovery()).toEqual(creating);

    writeRaw(recovery.sessionKey, { ...creating, createParams: { key: "agent:cloud:other" } });
    expect(readRecovery()).toBeNull();
  });
});
