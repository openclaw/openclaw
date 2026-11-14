import { afterEach, expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { withSessionTranscriptWrite } from "../plugin-sdk/session-transcript-runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createGatewaySession,
  SessionCreationNotCommittedError,
} from "./session-create-service.js";
import type { CreatedGatewaySession } from "./session-create-service.types.js";

afterEach(() => memorySessionActorOwners.reset());

async function appendImportedMessage({ agentId, entry, key, storePath }: CreatedGatewaySession) {
  const scope = { agentId, sessionId: entry.sessionId, sessionKey: key, storePath };
  await withSessionTranscriptWrite(scope, async (transcript) => {
    await transcript.appendMessage({
      message: { role: "user", content: "Imported snapshot", timestamp: 1 },
    });
  });
  return scope;
}

it.each([
  ["atomic success", true, undefined],
  ["atomic rollback", true, "snapshot changed"],
  ["ordinary post-commit failure", false, "initial turn failed"],
] as const)("initializes sessions: %s", async (label, atomic, failure) => {
  await withOpenClawTestState({ label }, async () => {
    const key = "agent:main:initializer";
    let scope: Awaited<ReturnType<typeof appendImportedMessage>> | undefined;
    const created = await createGatewaySession({
      cfg: {},
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      atomicInitialization: atomic ? true : undefined,
      afterCreate: async (session) => {
        if (atomic) {
          expect(session.entry.initializationPending).toBe(true);
          scope = await appendImportedMessage(session);
        }
        if (failure) {
          throw new Error(failure);
        }
      },
    });
    if (atomic && failure) {
      expect(created).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: `session initialization failed: ${failure}` },
      });
      expect(loadSessionEntryReadOnly({ sessionKey: key })).toBeUndefined();
      return;
    }
    expect(created).toMatchObject({
      ok: true,
      postCommit: failure
        ? { status: "failed", error: expect.any(Error) }
        : { status: "completed" },
    });
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    expect(created.entry.initializationPending).toBeUndefined();
    expect(loadSessionEntryReadOnly({ sessionKey: key })?.initializationPending).toBeUndefined();
    if (!failure) {
      expect(scope).toBeDefined();
      expect(JSON.stringify(await loadTranscriptEvents(scope!))).toContain("Imported snapshot");
    }
  });
});

it("atomically stamps catalog origin without plugin runtime ownership", async () => {
  await withOpenClawTestState({ label: "catalog logical continuation" }, async () => {
    const key = "agent:main:dashboard:catalog-origin";
    const origin = {
      id: "receiver-generation",
      catalogId: "sample",
      hostId: "source-host",
      threadId: "source-thread",
    };
    const created = await createGatewaySession({
      cfg: {},
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      atomicInitialization: true,
      initialCatalogContinuation: origin,
      afterCreate: async (session) => {
        expect(session.entry.pluginExtensions?.sample).toEqual({ catalogContinuation: origin });
        expect(session.entry.pluginOwnerId).toBeUndefined();
        await appendImportedMessage(session);
      },
    });
    expect(created.ok).toBe(true);
    const stored = loadSessionEntryReadOnly({ sessionKey: key });
    expect(stored?.pluginExtensions?.sample).toEqual({ catalogContinuation: origin });
    expect(stored?.initializationPending).toBeUndefined();
    expect(stored?.pluginOwnerId).toBeUndefined();
    const refused = await createGatewaySession({
      cfg: {},
      key,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      initialCatalogContinuation: { ...origin, id: "replacement" },
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(loadSessionEntryReadOnly({ sessionKey: key })?.pluginExtensions?.sample).toEqual({
      catalogContinuation: origin,
    });
  });
});

it.each(["admission", "publication", "initialTurn"] as const)(
  "recovers the same ordinary conversation after a thrown %s failure",
  async (phase) => {
    await withOpenClawTestState({ label: "catalog creation failure custody" }, async () => {
      const key = "agent:main:dashboard:retry-origin";
      const origin = {
        id: "one-logical-generation",
        catalogId: "sample",
        hostId: "host",
        threadId: "thread",
      };
      const failure = new Error("source publication changed during creation");
      const base = {
        cfg: {},
        key,
        commandSource: "test",
        operatorRoleActor: { kind: "system" as const },
        atomicInitialization: true as const,
        initialCatalogContinuation: origin,
        afterCreate: async (session: CreatedGatewaySession) => {
          await appendImportedMessage(session);
        },
      };
      const creating = createGatewaySession({
        ...base,
        onPhase(current) {
          if (current === phase) {
            throw failure;
          }
        },
      });
      if (phase === "admission") {
        await expect(creating).rejects.toBeInstanceOf(SessionCreationNotCommittedError);
      } else {
        await expect(creating).resolves.toMatchObject({
          ok: false,
          initializationRolledBack: true,
        });
      }
      expect(loadSessionEntryReadOnly({ sessionKey: key })).toBeUndefined();
      const retry = await createGatewaySession(base);
      expect(retry).toMatchObject({ ok: true });
      expect(loadSessionEntryReadOnly({ sessionKey: key })?.pluginExtensions?.sample).toEqual({
        catalogContinuation: origin,
      });
    });
  },
);

it.each([false, true])(
  "certifies a final pre-write guard rejection with incognito=%s",
  async (incognito) => {
    await withOpenClawTestState({ label: "catalog final commit guard" }, async () => {
      const key = `agent:main:dashboard:${incognito ? "incognito-" : ""}guard-retry`;
      let deny = false;
      const base = {
        cfg: {},
        key,
        incognito,
        commandSource: "test",
        operatorRoleActor: { kind: "system" as const },
        atomicInitialization: true as const,
        initialCatalogContinuation: {
          id: "guarded",
          catalogId: "sample",
          hostId: "host",
          threadId: "thread",
        },
        afterCreate: async (session: CreatedGatewaySession) => {
          await appendImportedMessage(session);
        },
      };
      await expect(
        createGatewaySession({
          ...base,
          onPhase(phase) {
            if (phase === "commit") {
              deny = true;
            }
          },
          commitGuard() {
            if (deny) {
              throw new Error("publication guard rejected before write");
            }
          },
        }),
      ).rejects.toBeInstanceOf(SessionCreationNotCommittedError);
      expect(loadSessionEntryReadOnly({ sessionKey: key })).toBeUndefined();
      const retry = await createGatewaySession(base);
      expect(retry, JSON.stringify(retry)).toMatchObject({ ok: true, key });
    });
  },
);
