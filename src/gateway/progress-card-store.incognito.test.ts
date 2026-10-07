import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { readAcpSessionEntryAsync } from "../acp/runtime/session-meta-read.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta-write.js";
import {
  readSessionManagerModelContextAsync,
  readSessionManagerContextAsync,
} from "../agents/sessions/session-manager-incognito.js";
import { appendSessionTranscriptNote } from "../agents/sessions/session-manager-write-admission.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { loadSessionEntryForAdmission } from "../config/sessions/session-accessor.sqlite-entry-admission.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { createIncognitoPendingInputHistoryReader } from "../config/sessions/session-pending-input-history.js";
import {
  SessionReactionMessageMissingError,
  setSessionReactionAsync,
} from "../config/sessions/session-reaction-store.js";
import * as workerStores from "../infra/sqlite-worker-store.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { createIncognitoProgressCardStore, progressCardStore } from "./progress-card-store.js";
import { createIncognitoSessionComputeReader } from "./session-history-snapshot.js";

// The retained suite actor, shared state, and closing actor require three broker slots.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 24,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-domain-facades-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
afterAll(async () => {
  await actor?.close();
});

async function fixture(name: string, source = authority) {
  const target = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    storePath: actor.path,
    env,
  };
  const scope = { ...target, incognito: { actor, authority: source } };
  await actor.sessions.create(authority, {
    sessionKey: scope.sessionKey,
    entry: { sessionId: name, lifecycleRevision: "initial", updatedAt: 1, incognito: true },
  });
  const appended = await withIncognitoSessionActor(actor, () =>
    appendSessionTranscriptNote(target, makeUserMessage("Private message", 1)),
  );
  assert(appended);
  const reaction = {
    messageId: appended.messageId,
    expectedSessionId: name,
    emoji: "👍",
    identityId: "viewer",
  };
  const store = createIncognitoProgressCardStore(() => scope);
  return { scope, reaction, store };
}

it("composes reactions and progress-card revisions without caller SQL", async () => {
  const prepared = await fixture("composition");
  const { reaction } = prepared;
  const scope = { ...prepared.scope, incognito: undefined };
  const store = progressCardStore;
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      expect(await setSessionReactionAsync(scope, reaction)).toMatchObject({ changed: true });
      await expect(
        setSessionReactionAsync(scope, { ...reaction, messageId: "missing" }),
      ).rejects.toBeInstanceOf(SessionReactionMessageMissingError);
      expect(
        await actor.sessions.sideData(authority, {
          type: "session.reactions.read",
          input: { sessionKey: scope.sessionKey, sessionId: scope.sessionId },
        }),
      ).toEqual({
        [reaction.messageId]: [{ emoji: "👍", count: 1, identities: [{ id: "viewer" }] }],
      });
      expect(await store.put(scope.sessionKey, { markdown: "First" })).toMatchObject({
        card: { revision: 1, markdown: "First" },
      });
      expect(await store.put(scope.sessionKey, { markdown: "Second" })).toMatchObject({
        card: { revision: 2 },
      });
      expect(await store.put(scope.sessionKey, { expectedRevision: 1 })).toMatchObject({
        card: { revision: 2 },
      });
      expect(await store.get(scope.sessionKey)).toMatchObject({ markdown: "Second", revision: 2 });
      expect(await store.put(scope.sessionKey, { expectedRevision: 2 })).toEqual({ card: null });
      expect(await store.get(scope.sessionKey)).toBeNull();
      expect(sql.queries).toEqual([]);
      expect(existsSync(actor.path)).toBe(false);
    });
  } finally {
    vi.unstubAllEnvs();
    sql.restore();
  }
});

it("retains independent admission claims and revokes only the released claim", async () => {
  const { scope } = await fixture("admission");
  const sql = observeHostDataSql();
  const claims: Awaited<ReturnType<typeof loadSessionEntryForAdmission>>[] = [];
  try {
    claims.push(await loadSessionEntryForAdmission(scope, { incognito: scope.incognito }));
    claims.push(await loadSessionEntryForAdmission(scope, { incognito: scope.incognito }));
    const first = claims[0]!;
    const second = claims[1]!;
    expect(first.entry).toMatchObject({ sessionId: scope.sessionId });
    expect(first.databaseClaim.identity).toBe(second.databaseClaim.identity);
    expect(first.databaseClaim.incarnation).toBe(actor.identity.incarnation);
    await first.databaseClaim.release();
    expect(first.databaseClaim.isCurrent()).toBe(false);
    expect(second.databaseClaim.isCurrent()).toBe(true);
    actor.assertCurrent();
    await second.databaseClaim.release();
    expect(second.databaseClaim.isCurrent()).toBe(false);
    expect(sql.queries).toEqual([]);
  } finally {
    await Promise.all(claims.map(({ databaseClaim }) => Promise.resolve(databaseClaim.release())));
    sql.restore();
  }
});

it.each(["card-read", "card-write", "reaction-write"] as const)(
  "rechecks %s caller authority after retained settlement",
  async (operation) => {
    const { scope, reaction, store } = await fixture(`settled-${operation}`);
    await store.put(scope.sessionKey, { markdown: "Private stored card" });
    await setSessionReactionAsync(scope, reaction);
    let allowed = true;
    const current: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("Domain caller authority ended");
        }
      },
    };
    const bound = { ...scope, incognito: { actor, authority: current } };
    const cards = createIncognitoProgressCardStore(() => bound);
    const retain = actor.sessions.withSharedState.bind(actor.sessions);
    const settle = async <T>(work: () => Promise<T>): Promise<T> => {
      const value = await retain(work);
      allowed = false;
      return value;
    };
    const settled = vi.spyOn(actor.sessions, "withSharedState").mockImplementationOnce(settle);
    try {
      const work =
        operation === "card-read"
          ? cards.get(scope.sessionKey)
          : operation === "card-write"
            ? cards.put(scope.sessionKey, { expectedRevision: 999 })
            : setSessionReactionAsync(bound, { ...reaction, identityId: "writer" });
      await expect(work).rejects.toThrow("Domain caller authority ended");
      actor.assertReadable();
      expect(await store.get(scope.sessionKey)).toMatchObject({
        markdown: "Private stored card",
        revision: 1,
      });
      if (operation === "reaction-write") {
        expect(
          await actor.sessions.sideData(authority, {
            type: "session.reactions.read",
            input: { sessionKey: scope.sessionKey, sessionId: scope.sessionId },
          }),
        ).toMatchObject({ [reaction.messageId]: [{ count: 2 }] });
      }
    } finally {
      settled.mockRestore();
    }
  },
);

it("rechecks native context authority after retained settlement", async () => {
  const { scope } = await fixture("settled-native-context");
  const controller = new AbortController();
  await withIncognitoSessionActor(actor, async () => {
    const retain = actor.sessions.withSharedState.bind(actor.sessions);
    const settle = async <T>(work: () => Promise<T>): Promise<T> => {
      const value = await retain(work);
      controller.abort(new Error("Context caller authority ended"));
      return value;
    };
    const settled = vi.spyOn(actor.sessions, "withSharedState").mockImplementationOnce(settle);
    try {
      await expect(
        readSessionManagerContextAsync(scope, (messages) => [...messages], {
          signal: controller.signal,
        }),
      ).rejects.toThrow("Context caller authority ended");
      actor.assertReadable();
    } finally {
      settled.mockRestore();
    }
  });
});

it.each(["transaction", "commit"] as const)(
  "rolls domain mutations back when current authority refuses at %s",
  async (stage) => {
    let refused = true;
    const { scope, reaction, store } = await fixture(`refused-${stage}`, {
      assertCurrent() {},
      authorize(currentStage) {
        if (refused && currentStage === stage) {
          throw new Error("Domain authority revoked");
        }
      },
    });
    await expect(setSessionReactionAsync(scope, reaction)).rejects.toThrow(
      "Domain authority revoked",
    );
    await expect(store.put(scope.sessionKey, { markdown: "Refused" })).rejects.toThrow(
      "Domain authority revoked",
    );
    refused = false;
    expect(await store.get(scope.sessionKey)).toBeNull();
    expect(await setSessionReactionAsync(scope, { ...reaction, remove: true })).toMatchObject({
      changed: false,
    });
  },
);

it.each([
  "acp",
  "pending",
  "board",
  "model-context",
  "native-context",
  "hydration",
  "progress-write",
  "reaction-write",
  "board-write",
  "acp-write",
] as const)("refuses %s disclosure to a retained parent after release", async (reader) => {
  const { scope, reaction, store: initialStore } = await fixture(`retained-${reader}`);
  if (reader === "progress-write") {
    await initialStore.put(scope.sessionKey, { markdown: "Stored private progress" });
  } else if (reader === "reaction-write") {
    await setSessionReactionAsync(scope, reaction);
  } else if (reader === "board-write") {
    await new SqliteBoardStore({
      env,
      resolveSession: () => ({ ...scope, path: actor.path }),
    }).putWidget({
      sessionKey: scope.sessionKey,
      name: "stored",
      content: { kind: "html", html: "<p>Stored private Board</p>" },
    });
  }
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: actor.agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  let retiring: Promise<void> | undefined;
  let reading = false;
  const source: IncognitoSessionAuthority = {
    assertCurrent() {},
    authorize(stage) {
      if (reading && reader !== "board" && stage === "commit") {
        retiring ??= borrowed.release();
      }
    },
  };
  const bound = { ...scope, incognito: { actor: borrowed, authority: source } };
  const hydration =
    reader === "hydration"
      ? (
          await createIncognitoSessionComputeReader({
            actor: borrowed,
            authority: source,
            target: {
              sessionKey: scope.sessionKey,
              sessionId: scope.sessionId,
              lifecycleRevision: "initial",
            },
          })
        ).prepareHydration()
      : undefined;
  let disclosed = false;
  try {
    await expect(
      borrowed.sessions.withSharedState(async () => {
        reading = true;
        if (reader === "progress-write") {
          await createIncognitoProgressCardStore(() => bound).put(scope.sessionKey, {
            expectedRevision: 999,
          });
        } else if (reader === "reaction-write") {
          await setSessionReactionAsync(bound, { ...reaction, identityId: "writer" });
        } else if (reader === "board-write") {
          await new SqliteBoardStore({
            env,
            resolveSession: () => ({ ...bound, path: borrowed.path }),
          }).applyOps({ sessionKey: scope.sessionKey }, [
            { kind: "widget_resize", name: "stored", sizeW: 8, sizeH: 6 },
          ]);
        } else if (reader === "acp-write") {
          await upsertAcpSessionMeta(
            {
              ...scope,
              cfg: {},
              mutate: () => ({
                backend: "fixture",
                agent: "fixture",
                runtimeSessionName: "private-runtime",
                mode: "persistent",
                state: "idle",
                lastActivityAt: 100,
              }),
            },
            { actor: borrowed, authority: source },
          );
        } else if (reader === "acp") {
          await readAcpSessionEntryAsync(
            { ...scope, cfg: {} },
            { actor: borrowed, authority: source },
          );
        } else if (reader === "pending") {
          await createIncognitoPendingInputHistoryReader({
            actor: borrowed,
            authority: source,
            target: {
              sessionKey: scope.sessionKey,
              sessionId: scope.sessionId,
              lifecycleRevision: "initial",
            },
          }).list();
        } else if (reader === "model-context" || reader === "native-context") {
          await withIncognitoSessionActor(borrowed, () => {
            const consume = () => {
              retiring = borrowed.release();
              return "private context result";
            };
            return reader === "model-context"
              ? readSessionManagerModelContextAsync(scope, {}, consume)
              : readSessionManagerContextAsync(scope, consume, {});
          });
        } else if (hydration) {
          await hydration.read();
        } else {
          const store = new SqliteBoardStore({
            env,
            resolveSession: () => ({ ...bound, path: borrowed.path }),
          });
          await store.useSnapshot(scope, async () => {
            retiring = borrowed.release();
            return "private Board result";
          });
        }
        disclosed = true;
      }),
    ).rejects.toThrow("reference is released");
    expect(disclosed).toBe(false);
    if (reader === "reaction-write") {
      expect(
        await actor.sessions.sideData(authority, {
          type: "session.reactions.read",
          input: { sessionKey: scope.sessionKey, sessionId: scope.sessionId },
        }),
      ).toMatchObject({ [reaction.messageId]: [{ count: 2 }] });
    } else if (reader === "progress-write") {
      expect(await initialStore.get(scope.sessionKey)).toMatchObject({
        markdown: "Stored private progress",
        revision: 1,
      });
    } else if (reader === "board-write") {
      expect(
        await actor.sessions.sideData(authority, {
          type: "session.boards.readSnapshot",
          input: { sessionKey: scope.sessionKey },
        }),
      ).toMatchObject({ snapshot: { revision: 2, widgets: [{ name: "stored" }] } });
    } else if (reader === "acp-write") {
      expect(await actor.acp.readEntry({ ...scope, authority, cfg: {} })).toMatchObject({
        acp: { runtimeSessionName: "private-runtime" },
      });
    }
  } finally {
    await retiring;
    await borrowed.release();
  }
});

it.each(["revocation", "release"] as const)(
  "refuses progress-card disclosure after %s during the worker read",
  async (ending) => {
    let allowed = true;
    let reading = false;
    let retiring: Promise<void> | undefined;
    const { scope } = await fixture(`read-${ending}`);
    const borrowed = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrowed);
    const source: IncognitoSessionAuthority = {
      assertCurrent() {
        if (!allowed) {
          throw new Error("Card reader revoked");
        }
      },
      authorize(stage) {
        if (reading && stage === "commit") {
          if (ending === "revocation") {
            allowed = false;
          } else {
            retiring ??= borrowed.release();
          }
        }
      },
    };
    const store = createIncognitoProgressCardStore(() => ({
      ...scope,
      incognito: { actor: borrowed, authority: source },
    }));
    try {
      await store.put(scope.sessionKey, { markdown: "Private" });
      reading = true;
      let disclosed = false;
      await expect(
        borrowed.sessions.withSharedState(async () => {
          const card = await store.get(scope.sessionKey);
          disclosed = true;
          return card;
        }),
      ).rejects.toThrow();
      expect(disclosed).toBe(false);
    } finally {
      await retiring;
      await borrowed.release();
    }
  },
);

it("refuses private read and mutation responses while accepted work settles during close", async () => {
  const closingActor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "response-close",
    env,
    authority,
  });
  assert(closingActor);
  const target = {
    agentId: closingActor.agentId,
    sessionKey: "agent:response-close:dashboard:incognito-response",
    sessionId: "response-close",
    storePath: closingActor.path,
    env,
  };
  let closing: Promise<void> | undefined;
  try {
    await closingActor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: {
        sessionId: target.sessionId,
        lifecycleRevision: "initial",
        updatedAt: 1,
        incognito: true,
      },
    });
    const appended = await withIncognitoSessionActor(closingActor, () =>
      appendSessionTranscriptNote(target, makeUserMessage("Private closing message", 1)),
    );
    assert(appended);
    const initial = { ...target, incognito: { actor: closingActor, authority } };
    await createIncognitoProgressCardStore(() => initial).put(target.sessionKey, {
      markdown: "Private closing card",
    });
    const reaction = {
      messageId: appended.messageId,
      expectedSessionId: target.sessionId,
      emoji: "👍",
      identityId: "viewer",
    };
    await setSessionReactionAsync(initial, reaction);
    const source: IncognitoSessionAuthority = {
      assertCurrent() {},
      authorize(stage) {
        if (stage === "commit") {
          closing ??= closingActor.close();
        }
      },
    };
    const bound = { ...target, incognito: { actor: closingActor, authority: source } };
    const store = createIncognitoProgressCardStore(() => bound);
    let results: PromiseSettledResult<unknown>[] = [];
    await expect(
      closingActor.sessions.withSharedState(async () => {
        results = await Promise.allSettled([
          store.get(target.sessionKey),
          store.put(target.sessionKey, { expectedRevision: 999 }),
          setSessionReactionAsync(bound, { ...reaction, identityId: "writer" }),
        ]);
      }),
    ).rejects.toBeInstanceOf(IncognitoSessionEndedError);
    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({
        status: "rejected",
        reason: expect.any(IncognitoSessionEndedError),
      })),
    );
    await closing;
  } finally {
    await closingActor.close();
  }
});

it("keeps the actor transport alive through admission policy cleanup after close revokes the claim", async ({
  onTestFinished,
}) => {
  let nativeStore: { close(): Promise<void> } | undefined;
  const open = workerStores.openEphemeralAgentDatabaseSqliteWorkerStore;
  const opening = vi
    .spyOn(workerStores, "openEphemeralAgentDatabaseSqliteWorkerStore")
    .mockImplementation(async (...args) => {
      const store = await open(...args);
      nativeStore = store;
      return store;
    });
  onTestFinished(() => opening.mockRestore());
  const closingActor = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "claim-close",
    env,
    authority,
  });
  opening.mockRestore();
  assert(closingActor && nativeStore);
  onTestFinished(() => closingActor.close());
  const scope = {
    agentId: closingActor.agentId,
    sessionKey: "agent:claim-close:dashboard:incognito-claim",
    storePath: closingActor.path,
    env,
    incognito: { actor: closingActor, authority },
  };
  await closingActor.sessions.create(authority, {
    sessionKey: scope.sessionKey,
    entry: { sessionId: "claim-close", updatedAt: 1, incognito: true },
  });
  const { databaseClaim } = await loadSessionEntryForAdmission(scope, {
    incognito: scope.incognito,
  });
  onTestFinished(() => databaseClaim.release());
  const closeTransport = vi.spyOn(nativeStore, "close");
  const closing = closingActor.close();
  try {
    expect(() => databaseClaim.assertCurrent()).toThrow(IncognitoSessionEndedError);
    expect(databaseClaim.isCurrent()).toBe(false);
    // A full microtask checkpoint lets close reach its transport unless the claim retains it.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(closeTransport).not.toHaveBeenCalled();
    const releasing = databaseClaim.release();
    expect(() => databaseClaim.assertCurrent()).toThrow("admission claim is released");
    await Promise.all([releasing, closing]);
    expect(closeTransport).toHaveBeenCalledOnce();
  } finally {
    await databaseClaim.release();
    await closing;
    closeTransport.mockRestore();
  }
});
