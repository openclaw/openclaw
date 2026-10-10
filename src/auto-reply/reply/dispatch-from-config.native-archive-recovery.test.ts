import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { WorkerSessionPlacementRecord } from "../../gateway/worker-environments/placement-record.js";
import { bindCommandOwnerAuthority } from "../command-owner-authority.js";
import {
  createDispatcher,
  emptyConfig,
  placementContextMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const sourceKey = "agent:main:discord:slash:user-1";
const targetKey = "agent:main:discord:channel:room-1";
const storePath = "/tmp/mock-sessions.json";

beforeAll(globalBeforeAll0);

describe("native command archive recovery ownership", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
  });

  function prepareEntries(
    source: SessionEntry | undefined,
    target: SessionEntry | undefined,
    commandTargetKey: string,
  ) {
    const entries = new Map<string, SessionEntry & Record<string, unknown>>();
    if (source) {
      entries.set(sourceKey, { ...source });
    }
    if (target) {
      entries.set(commandTargetKey, { ...target });
    }
    sessionStoreMocks.loadSessionEntry.mockImplementation((scope) =>
      entries.get((scope as { sessionKey: string }).sessionKey),
    );
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation((scope) =>
      entries.get((scope as { sessionKey: string }).sessionKey),
    );
    sessionStoreMocks.updateSessionEntry.mockImplementation(async (scope, update) => {
      const key = (scope as { sessionKey: string }).sessionKey;
      const current = entries.get(key);
      if (!current) {
        return null;
      }
      const patch = await update(current);
      if (patch) {
        entries.set(key, { ...current, ...patch });
      }
      return entries.get(key) ?? null;
    });
    return entries;
  }

  async function admitNativeCommand(params: {
    command: "compact" | "new" | "reset" | "status";
    authorized?: boolean;
    sameKey?: boolean;
    noTargetOverride?: boolean;
    hasPluginOwnedBinding?: boolean;
    human?: boolean;
    assertCurrent?: () => void;
    afterEntriesPrepared?: (entries: Map<string, SessionEntry>) => void;
    configureContext?: (ctx: ReturnType<typeof buildTestCtx>) => void;
    source?: SessionEntry;
    target?: SessionEntry;
  }) {
    const commandTargetKey = params.sameKey ? sourceKey : targetKey;
    const entries = prepareEntries(params.source, params.target, commandTargetKey);
    params.afterEntriesPrepared?.(entries);
    const body = `/${params.command}`;
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      From: "discord:user:1",
      To: "discord:channel:room-1",
      ChatType: "channel",
      SessionKey: sourceKey,
      CommandTargetSessionKey: params.noTargetOverride ? undefined : commandTargetKey,
      Body: body,
      CommandBody: body,
      RawBody: body,
      CommandSource: "native",
      CommandAuthorized: params.authorized ?? true,
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: params.authorized ?? true,
        commandName: params.command,
        body,
      },
      InboundAccessAuthorized: true,
      InboundEventKind: "user_request",
      InputProvenance:
        params.human === false
          ? { kind: "internal_system", sourceTool: "heartbeat" }
          : { kind: "external_user", sourceChannel: "discord" },
    });
    params.configureContext?.(ctx);
    const operationSessionStoreEntry = { entry: params.source, storePath };
    const targetSessionStoreEntry = {
      entry: params.target,
      sessionKey: commandTargetKey,
      storePath,
    };
    const { createDispatchReplyOperationCoordinator } =
      await import("./dispatch-from-config.lifecycle.js");
    const coordinator = createDispatchReplyOperationCoordinator({
      agentId: "main",
      cfg: emptyConfig,
      ctx,
      assertCurrent: params.assertCurrent,
      dispatcher: createDispatcher(),
      dispatchOperationSessionKey: sourceKey,
      operationSessionStoreEntry,
      targetSessionStoreEntry,
      resolveOperationExpectedSessionId: () => params.source?.sessionId,
    });
    let outcome: unknown;
    try {
      outcome = await coordinator.ensureDispatchReplyOperation(
        "pre_dispatch",
        params.hasPluginOwnedBinding,
      );
    } catch (error) {
      outcome = error;
    } finally {
      await coordinator.releasePreDispatchLifecycleAdmission();
      coordinator.completeDispatchReplyOperation();
    }
    return { entries, outcome, operationSessionStoreEntry, targetSessionStoreEntry };
  }

  it("restores the detached source with its session identity while leaving the active target alone", async () => {
    const source = { sessionId: "source-history", updatedAt: 1, archivedAt: 2 };
    const target = { sessionId: "busy-target", updatedAt: 1 };
    const { createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js");
    const targetOperation = createReplyOperation({
      sessionKey: targetKey,
      sessionId: target.sessionId,
      resetTriggered: false,
    });
    try {
      const result = await admitNativeCommand({ command: "compact", source, target });
      expect(result.outcome).toEqual({ status: "ready" });
      expect(result.entries.get(sourceKey)).toMatchObject({ sessionId: "source-history" });
      expect(result.entries.get(sourceKey)?.archivedAt).toBeUndefined();
      expect(result.entries.get(targetKey)).toEqual(target);
      expect(replyRunRegistry.get(targetKey)).toBe(targetOperation);
      expect(targetOperation.abortSignal.aborted).toBe(false);
    } finally {
      targetOperation.complete();
    }
  });

  it.each(["new", "reset"] as const)("restores an archived explicit %s target", async (command) => {
    const result = await admitNativeCommand({
      command,
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1, archivedAt: 3 },
    });
    expect(result.outcome).toEqual({ status: "ready" });
    expect(result.entries.get(sourceKey)?.archivedAt).toBeUndefined();
    expect(result.entries.get(targetKey)).toMatchObject({ sessionId: "target-history" });
    expect(result.entries.get(targetKey)?.archivedAt).toBeUndefined();
  });

  it("uses the ordinary missing-source path before restoring an archived reset target", async () => {
    const result = await admitNativeCommand({
      command: "new",
      target: { sessionId: "target-history", updatedAt: 1, archivedAt: 3 },
    });
    expect(result.outcome).toEqual({ status: "ready" });
    expect(result.entries.has(sourceKey)).toBe(false);
    expect(result.entries.get(targetKey)?.archivedAt).toBeUndefined();
  });

  it.each(["new", "reset"] as const)(
    "restores a same-key archived native %s target before source admission",
    async (command) => {
      const entry = { sessionId: "same-key-history", updatedAt: 1, archivedAt: 2 };
      const result = await admitNativeCommand({
        command,
        sameKey: true,
        source: entry,
        target: entry,
      });
      expect(result.outcome).toEqual({ status: "ready" });
      expect(result.entries.get(sourceKey)).toMatchObject({ sessionId: "same-key-history" });
      expect(result.entries.get(sourceKey)?.archivedAt).toBeUndefined();
    },
  );

  it.each(["new", "reset"] as const)(
    "restores a same-key native %s target without an override",
    async (command) => {
      const entry = { sessionId: "same-key-history", updatedAt: 1, archivedAt: 2 };
      const result = await admitNativeCommand({
        command,
        sameKey: true,
        noTargetOverride: true,
        source: entry,
        target: entry,
      });
      expect(result.outcome).toEqual({ status: "ready" });
      expect(result.entries.get(sourceKey)?.archivedAt).toBeUndefined();
    },
  );

  it("keeps a same-key archived non-reset native target closed", async () => {
    const entry = { sessionId: "same-key-history", updatedAt: 1, archivedAt: 2 };
    const result = await admitNativeCommand({
      command: "status",
      sameKey: true,
      source: entry,
      target: entry,
    });
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });

  it("keeps a same-key archived non-reset native target without an override closed", async () => {
    const entry = { sessionId: "same-key-history", updatedAt: 1, archivedAt: 2 };
    const result = await admitNativeCommand({
      command: "status",
      sameKey: true,
      noTargetOverride: true,
      source: entry,
      target: entry,
    });
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });

  it.each([
    { name: "non-reset archived target", command: "status" as const, authorized: true },
    { name: "unauthorized reset", command: "new" as const, authorized: false },
  ])("keeps $name archived", async ({ command, authorized }) => {
    const result = await admitNativeCommand({
      command,
      authorized,
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1, archivedAt: 3 },
    });
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
    expect(result.entries.get(targetKey)?.archivedAt).toBe(3);
  });

  it.each([
    {
      name: "plugin-owned source",
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2, pluginOwnerId: "p" },
      target: { sessionId: "target-history", updatedAt: 1 },
    },
    {
      name: "plugin-owned target",
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1, pluginOwnerId: "p" },
    },
    {
      name: "restart tombstone",
      source: {
        sessionId: "source-history",
        updatedAt: 1,
        archivedAt: 2,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      },
      target: { sessionId: "target-history", updatedAt: 1 },
    },
  ])("does not restore a $name", async ({ source, target }) => {
    const result = await admitNativeCommand({ command: "status", source, target });
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
    expect(result.entries.get(targetKey)).toEqual(target);
  });

  it("does not restore with an unsafe worker placement", async () => {
    placementContextMocks.getMany.mockReturnValue(
      new Map([["source-history", { state: "active" } as WorkerSessionPlacementRecord]]),
    );
    const result = await admitNativeCommand({
      command: "status",
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1 },
    });
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });

  it.each([
    { name: "plugin binding", hasPluginOwnedBinding: true, human: true },
    { name: "nonhuman invocation", hasPluginOwnedBinding: false, human: false },
  ])("does not restore a $name", async ({ hasPluginOwnedBinding, human }) => {
    const result = await admitNativeCommand({
      command: "status",
      hasPluginOwnedBinding,
      human,
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1 },
    });
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });

  it("rechecks command-owner authority after placement preparation", async () => {
    let current = true;
    placementContextMocks.getMany.mockImplementation(() => {
      current = false;
      return new Map();
    });
    const result = await admitNativeCommand({
      command: "status",
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1 },
      configureContext: (ctx) => bindCommandOwnerAuthority(ctx, { isCurrent: () => current }),
    });
    expect(result.outcome).toBeInstanceOf(Error);
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });

  it("rechecks the dispatch generation after placement preparation", async () => {
    let current = true;
    placementContextMocks.getMany.mockImplementation(() => {
      current = false;
      return new Map();
    });
    const result = await admitNativeCommand({
      command: "status",
      source: { sessionId: "source-history", updatedAt: 1, archivedAt: 2 },
      target: { sessionId: "target-history", updatedAt: 1 },
      assertCurrent: () => {
        if (!current) {
          throw new Error("generation changed");
        }
      },
    });
    expect(result.outcome).toBeInstanceOf(Error);
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });

  it("rejects a source generation changed during placement preparation", async () => {
    let entries: Map<string, SessionEntry>;
    placementContextMocks.getMany.mockImplementation(() => {
      entries.set(sourceKey, {
        ...entries.get(sourceKey)!,
        lifecycleRevision: "replacement-generation",
      });
      return new Map();
    });
    const result = await admitNativeCommand({
      command: "status",
      source: {
        sessionId: "source-history",
        lifecycleRevision: "captured-generation",
        updatedAt: 1,
        archivedAt: 2,
      },
      target: { sessionId: "target-history", updatedAt: 1 },
      afterEntriesPrepared: (prepared) => {
        entries = prepared;
      },
    });
    expect(result.outcome).toBeInstanceOf(Error);
    expect(result.entries.get(sourceKey)?.archivedAt).toBe(2);
  });
});
