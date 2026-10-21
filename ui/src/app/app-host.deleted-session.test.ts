import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  readDurableComposerDraft,
  writeDurableComposerDraft,
} from "../lib/chat/composer-draft-store.runtime.ts";
import { requestResult } from "../lib/chat/control-ui-database.runtime.ts";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import "../lib/toast-host.ts";
import { createStoredChatOutboxReader } from "../lib/chat/outbox-store-projection.ts";
import {
  readStoredOutboxStore,
  storageTargetForGateway,
  storageTargetForComposer,
  storedChatOutboxScopeKey,
  writeStoredOutboxStore,
} from "../lib/chat/outbox-store.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createSessionDeletionHarness } from "../lib/sessions/session-deletion.test-support.ts";
import {
  clearPaneSessionHandoffs,
  consumePaneSessionHandoff,
  preparePaneSessionHandoff,
} from "../pages/chat/chat-pane-shared.ts";
import { reviewPrivateComposerDraft } from "../pages/chat/components/private-composer-recovery-dialog.tsx";
/* @vitest-environment jsdom */
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { committedRouterState, resetAppHostTestGlobals } from "./app-host.test-support.ts";
import type { ShellNavigationOwner } from "./app-shell-navigation.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import type { ApplicationContext } from "./context.ts";

type DeletedSessionShell = Omit<ReturnType<typeof createShellOwner>, "runtime"> & {
  runtime: { context: ApplicationContext };
  shellNavigation: ShellNavigationOwner;
};

const mainKey = "agent:main:main";
const deletedKey = "agent:main:deleted-thread";

const cleanupWarning = "Session deleted; browser draft remains. Clear site data.";
const scopeKey = storedChatOutboxScopeKey({ sessionKey: deletedKey, agentId: "main" });
const recoveryOwner = {
  gatewayOwner: "ws://gateway.test",
  recoveryScope: "deleted-session-owner",
  scopeKey: `chat:v3:${scopeKey}`,
};
type RecoveryOwner = typeof recoveryOwner;
const cleanups: Array<() => unknown> = [];

function attachOwner(shell: DeletedSessionShell, owner = recoveryOwner) {
  const client = {
    gatewayUrl: owner.gatewayOwner,
    recoveryScope: owner.recoveryScope,
    recoveryScopeReady: true,
  };
  const gateway = shell.runtime.context.gateway;
  gateway.snapshot.client = client as GatewayBrowserClient;
  gateway.connection.gatewayUrl = owner.gatewayOwner;
  return client;
}

function toastHost() {
  return document.body.appendChild(document.createElement("openclaw-toast-host"));
}

function expectCleanupWarning(toast: HTMLElement) {
  expect.soft(toast.textContent).toContain(cleanupWarning);
  expect.soft(toast.querySelectorAll(".app-toast")).toHaveLength(1);
}

async function persistDraft(owner: RecoveryOwner, text: string, writeId = text) {
  expect(
    await writeDurableComposerDraft(
      owner,
      { text, attachments: [], revision: 1 },
      { expectedRevision: 0, writeId },
    ),
  ).toMatchObject({ status: "persisted" });
}

async function expectDraft(owner: RecoveryOwner, status = "found", text?: string) {
  expect.soft(await readDurableComposerDraft(owner)).toMatchObject({
    status,
    ...(text === undefined ? {} : { draft: { text } }),
  });
}

function outbox(storage: Storage, owner = recoveryOwner, key = scopeKey) {
  const target = storageTargetForGateway(owner.gatewayOwner, owner.recoveryScope);
  return {
    read: () => storage.getItem(target.key),
    write(draft: string) {
      const queue = [{ id: "queued", text: "queued", createdAt: 1 }];
      writeStoredOutboxStore(storage, target, {
        version: 4,
        recovery: {},
        gatewayOwner: owner.gatewayOwner,
        sessions: { [key]: { draft, draftRevision: 1, updatedAt: 1, queue } },
      });
    },
    expectRetired(revision: number) {
      const tombstone = readStoredOutboxStore(storage, target).sessions[key];
      expect(tombstone).toEqual({
        draftRevision: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(tombstone?.draftRevision).toBeGreaterThan(revision);
    },
  };
}

function draftStorage() {
  const storage = createStorageMock();
  const indexedDb = new IDBFactory();
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("indexedDB", indexedDb);
  cleanups.push(() => requestResult(indexedDb.deleteDatabase("openclaw-control-ui")));
  return storage;
}

function recoveryShell(
  params: {
    activeSessionKey?: string;
    sessionKeys?: string[];
    deletedSessionKeys?: string[];
    sessions?: ApplicationContext["sessions"];
  } = {},
) {
  const replace = vi.fn();
  const setSessionKey = vi.fn();
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  const agentsList = { defaultId: "main", mainKey: "main", agents: [{ id: "main" }] };
  gateway.setSessionKey = setSessionKey;
  gateway.snapshot.phase = "connected";
  const shell = createShellOwner() as unknown as DeletedSessionShell;
  shell.runtime = {
    context: {
      basePath: "",
      chatAttachmentHandoff: createChatAttachmentHandoff(gateway),
      chatSubmissions: createChatSubmissions(),
      placementStartup: { get: () => null },
      agents: { state: { agentsList } },
      agentSelection: { set: vi.fn(), state: { selectedId: "main" } },
      gateway,
      sessions: params.sessions ?? {
        deletionState: (key: string) =>
          params.deletedSessionKeys?.includes(key) ? "confirmed" : undefined,
        state: {
          deletedSessions: (params.deletedSessionKeys ?? []).map((key) => ({
            agentId: "main",
            key,
            retireBeforeRevision: Date.now(),
          })),
          result: { sessions: (params.sessionKeys ?? [deletedKey]).map((key) => ({ key })) },
        },
      },
      replace,
    } as unknown as ApplicationContext,
  };
  shell.activeSessionKey = params.activeSessionKey ?? deletedKey;
  shell.routeState = { routeId: "chat" };
  cleanups.push(() => {
    clearPaneSessionHandoffs(shell.runtime.context, "retained");
    shell.runtime.context.chatAttachmentHandoff.dispose();
  });
  return { replace, setSessionKey, shell, publishGateway: () => fixture.publish(gateway.snapshot) };
}

function createDeletionHarness(request: ReturnType<typeof vi.fn>) {
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const sessions = createTestSessionCapability(harness.gateway);
  cleanups.push(() => sessions.dispose());
  const watch = (sessionKeys = [deletedKey, mainKey]) => {
    const fixture = recoveryShell({ sessionKeys, sessions });
    cleanups.push(sessions.subscribe(() => fixture.shell.recoverDeletedActiveSession()));
    return { ...fixture, toast: toastHost() };
  };
  return { ...harness, sessions, watch };
}

afterEach(async () => {
  try {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  } finally {
    document.body.replaceChildren();
    resetAppHostTestGlobals();
  }
});

describe("OpenClaw shell deleted-session recovery", () => {
  it.each([
    "initial readiness",
    "late readiness",
    "late principal change",
    "stalled readiness",
  ] as const)("keeps draft cleanup scoped through %s", async (transition) => {
    const stalled = transition === "stalled readiness";
    const changedPrincipal = transition === "late principal change";
    const late = transition === "late readiness" || changedPrincipal;
    const storage = draftStorage();
    const owner = {
      gatewayOwner: "ws://gateway.example.test",
      recoveryScope: "original-principal",
      scopeKey: `chat:v3:${scopeKey}`,
    };
    const drafts = outbox(storage, owner);
    const { shell, publishGateway } = recoveryShell({ deletedSessionKeys: [deletedKey] });
    const context = shell.runtime.context;
    const client = attachOwner(shell, owner);
    const handoff = { owner: client as GatewayBrowserClient, paneId: "retained", scopeKey };
    const toast = toastHost();
    await persistDraft(owner, "retire me", "readiness");
    drafts.write("retire queued draft");
    const stored = drafts.read();
    if (transition === "initial readiness") {
      client.recoveryScope = "";
      client.recoveryScopeReady = false;
    }
    preparePaneSessionHandoff(context, "retained", deletedKey, {
      draft: "retire pane draft",
      attachments: [],
    });
    context.chatAttachmentHandoff.prepare({
      ...handoff,
      reviewPrivateDraft: reviewPrivateComposerDraft,
      message: "retire attachment handoff",
      attachments: [],
      fallbacks: {},
    });
    if (stalled) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    if (!changedPrincipal) {
      client.recoveryScope = "";
    }
    client.recoveryScopeReady = false;
    shell.observeDeletedSessions({
      ...context.sessions.state,
      deletedSessions: [{ key: deletedKey, agentId: "main", retireBeforeRevision: Date.now() + 1 }],
    });
    expect.soft(consumePaneSessionHandoff(context, "retained", deletedKey)).toBeNull();
    expect.soft(context.chatAttachmentHandoff.consume(handoff)).toBeNull();
    if (late || stalled) {
      await vi.dynamicImportSettled();
      if (stalled) {
        await vi.advanceTimersByTimeAsync(10_000);
        expectCleanupWarning(toast);
      } else {
        expect.soft(toast.textContent).toBe("");
      }
      await expectDraft(owner);
      expect.soft(drafts.read()).toBe(stored);
    }
    if (stalled) {
      vi.useRealTimers();
    }
    client.recoveryScope = changedPrincipal ? "other-principal" : owner.recoveryScope;
    client.recoveryScopeReady = true;
    publishGateway();
    await vi.dynamicImportSettled();

    await expectDraft(owner, stalled || changedPrincipal ? "found" : "not-found");
    if (changedPrincipal) {
      expect.soft(drafts.read()).toBe(stored);
      expect.soft(toast.textContent).toContain(cleanupWarning);
    } else if (!stalled) {
      expect.soft(toast.textContent).toBe("");
    }
  });

  it.each(["gateway switch", "principal change", "disconnect", "credentials change"] as const)(
    "preserves drafts and reports failed cleanup after a %s during import",
    async (change) => {
      const storage = draftStorage();
      const original = {
        gatewayOwner: "ws://original.test",
        recoveryScope: "original-principal",
        scopeKey: `chat:v3:${scopeKey}`,
      };
      const other = {
        ...original,
        gatewayOwner: change === "principal change" ? original.gatewayOwner : "ws://other.test",
        recoveryScope: "other-principal",
      };
      const { shell } = recoveryShell({ deletedSessionKeys: [deletedKey] });
      for (const owner of [original, other]) {
        await persistDraft(owner, owner.recoveryScope);
        outbox(storage, owner).write(owner.gatewayOwner);
      }
      const originalDrafts = outbox(storage, original);
      const otherDrafts = outbox(storage, other);
      const otherStored = otherDrafts.read();
      const client = attachOwner(shell, original);
      const context = shell.runtime.context;
      const originalStored = originalDrafts.read();
      const toast = toastHost();

      shell.observeDeletedSessions(context.sessions.state);
      if (change === "principal change") {
        client.recoveryScope = other.recoveryScope;
      } else if (change === "credentials change") {
        Object.assign(context.gateway, { connectionRevision: 1 });
      } else {
        context.gateway.snapshot.client =
          change === "disconnect"
            ? null
            : ({ ...client, gatewayUrl: other.gatewayOwner } as GatewayBrowserClient);
      }
      await vi.dynamicImportSettled();

      await expectDraft(original, "found", original.recoveryScope);
      await expectDraft(other, "found", other.recoveryScope);
      expect.soft(originalDrafts.read()).toBe(originalStored);
      expectCleanupWarning(toast);
      expect.soft(otherDrafts.read()).toBe(otherStored);
    },
  );

  it("keeps an interrupted first prompt visible after temporary-session cleanup", () => {
    const { shell, replace, setSessionKey } = recoveryShell({
      sessionKeys: [mainKey],
      deletedSessionKeys: [deletedKey],
    });
    const context = shell.runtime.context;
    const get = vi.spyOn(context.placementStartup, "get").mockReturnValue({
      sessionKey: deletedKey,
      phase: "cancelled",
      startedAt: 1,
      initialTurn: {
        id: "unsent",
        text: "keep this interrupted task",
        createdAt: 1,
        sendState: "failed",
      },
      retryable: false,
    });
    shell.recoverDeletedActiveSession();
    expect(shell.activeSessionKey).toBe(deletedKey);
    expect(replace).not.toHaveBeenCalled();
    expect(setSessionKey).not.toHaveBeenCalled();
    get.mockReturnValue(null);
    shell.recoverDeletedActiveSession();
    expect(shell.activeSessionKey).toBe(mainKey);
    expect(replace).toHaveBeenCalledOnce();
  });
  it.each(["rejection", "batch interruption", "different-client batch rejection"] as const)(
    "navigates on delete intent and visibly reports %s without replacing newer navigation",
    async (failure) => {
      const staleClient = failure === "different-client batch rejection";
      const response = createDeferred<{ deleted: boolean }>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.delete") {
          return response.promise;
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        return sessionsResult([], 1);
      });
      const { gateway, publish, sessions, watch } = createDeletionHarness(request);
      const { shell, replace, toast } = watch();
      const operation =
        failure === "rejection"
          ? sessions.delete(deletedKey)
          : sessions.deleteMany([{ key: deletedKey }, { key: "agent:main:unsent" }]);
      expect(shell.activeSessionKey).toBe(mainKey);
      expect(sessions.deletionState(deletedKey)).toBe("pending");
      expect(sessions.state.deletedSessions).toEqual([]);
      expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
      shell.activeSessionKey = "agent:main:another-thread";
      replace.mockClear();
      if (failure === "rejection") {
        response.reject(new Error("delete rejected"));
        await expect(operation).rejects.toThrow("delete rejected");
      } else {
        publish(false);
        publish(
          true,
          staleClient ? ({ request } as unknown as GatewayBrowserClient) : gateway.snapshot.client,
        );
        if (staleClient) {
          response.reject(new Error("old client rejected deletion"));
        } else {
          response.resolve({ deleted: true });
        }
        await operation;
        expect(request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(
          1,
        );
      }
      expect(shell.activeSessionKey).toBe("agent:main:another-thread");
      expect(replace).not.toHaveBeenCalled();
      if (staleClient) {
        expect(toast.textContent).toBe("");
        expect(sessions.state.error).toBeNull();
      } else {
        await vi.waitFor(() =>
          expect(toast.textContent).toContain(
            failure === "rejection" ? "delete rejected" : "Gateway connection replaced",
          ),
        );
      }
    },
  );

  it("preserves the replacement when confirmation selected its deleted predecessor", async () => {
    const response = createDeferred<{ deleted: boolean }>();
    const replacement = {
      key: deletedKey,
      sessionId: "replacement",
      kind: "direct" as const,
      updatedAt: 2,
    };
    let listed = { ...replacement, sessionId: "predecessor" };
    const request = vi.fn(async (method: string) =>
      method === "sessions.delete" ? response.promise : sessionsResult([listed], 2),
    );
    const { emitEvent, sessions, watch } = createDeletionHarness(request);
    await sessions.refresh({ force: true });
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: deletedKey, sessionId: "predecessor", reason: "delete" },
    });
    listed = replacement;
    await sessions.refresh({ force: true });
    const { shell, replace, toast } = watch([deletedKey]);
    const operation = sessions.delete(deletedKey, { expectedSessionId: "predecessor" });
    try {
      expect(shell.activeSessionKey).toBe(deletedKey);
      expect(replace).not.toHaveBeenCalled();
      expect(sessions.state.result?.sessions).toEqual([replacement]);
      expect(request).toHaveBeenCalledWith(
        "sessions.delete",
        expect.objectContaining({ key: deletedKey, expectedSessionId: "predecessor" }),
        expect.any(Object),
      );
      response.reject(new Error("Session identity changed"));
      await expect(operation).rejects.toThrow("Session identity changed");
      await vi.waitFor(() => expect(toast.textContent).toContain("Session identity changed"));
      expect(shell.activeSessionKey).toBe(deletedKey);
      expect(sessions.state.result?.sessions).toEqual([replacement]);
    } finally {
      response.resolve({ deleted: false });
      await operation.catch(() => {});
    }
  });

  it.each([
    { priorLocalDelete: false, identified: false },
    { priorLocalDelete: true, identified: true },
  ])(
    "preserves recreated B on delayed A delete (local: $priorLocalDelete, identity: $identified)",
    async ({ priorLocalDelete, identified }) => {
      const h = createSessionDeletionHarness();
      cleanups.push(() => h.sessions.dispose());
      const storage = createStorageMock();
      vi.stubGlobal("sessionStorage", storage);
      const drafts = outbox(storage, recoveryOwner, `${h.alpha.key}\u0000agent:main`);
      const replacement = { ...h.alpha, sessionId: "generation-b" };
      const { shell, replace } = recoveryShell({
        activeSessionKey: h.alpha.key,
        sessionKeys: [h.alpha.key],
        sessions: h.sessions,
      });
      attachOwner(shell);
      await h.sessions.refresh({ force: true });
      // A is deleted externally unless this client owns the optional local RPC.
      h.setRows([h.sibling]);
      if (priorLocalDelete) {
        const deletion = h.sessions.delete(h.alpha.key);
        h.responses.get(h.alpha.key)!.resolve({ deleted: true });
        await deletion;
      }
      h.setRows([replacement, h.sibling]);
      await h.sessions.refresh({ force: true });
      drafts.write("B draft");
      const draft = drafts.read();
      cleanups.push(
        h.sessions.subscribe((state) => {
          shell.observeDeletedSessions(state);
          shell.recoverDeletedActiveSession();
        }),
      );
      const payload = {
        sessionKey: h.alpha.key,
        agentId: "main",
        reason: "delete",
        ...(identified ? { sessionId: h.alpha.sessionId } : {}),
      };
      h.emitEvent({ type: "event", event: "sessions.changed", payload });
      await import("../lib/chat/composer-draft-retirement.runtime.ts");
      expect.soft(h.sessions.state.result?.sessions).toEqual([replacement, h.sibling]);
      expect.soft(shell.activeSessionKey).toBe(h.alpha.key);
      expect.soft(replace).not.toHaveBeenCalled();
      expect.soft(drafts.read()).toBe(draft);
      expect.soft(h.sessions.deletionState(h.alpha.key)).toBeUndefined();
      await h.sessions.refresh({ force: true });
      expect(h.sessions.state.result?.sessions).toEqual([replacement, h.sibling]);
      // The same delivery path must still retire B when B itself is confirmed deleted.
      h.setRows([h.sibling]);
      const currentDelete = { ...payload, sessionId: replacement.sessionId };
      h.emitEvent({ type: "event", event: "sessions.changed", payload: currentDelete });
      const retired = h.sessions.state.deletedSessions.find(({ key }) => key === h.alpha.key)!;
      await vi.waitFor(() => {
        drafts.expectRetired(retired.retireBeforeRevision);
      });
      expect(h.sessions.state.result?.sessions).toEqual([h.sibling]);
      expect(h.sessions.deletionState(h.alpha.key)).toBe("confirmed");
      expect(h.sessions.deletionState(h.sibling.key)).toBeUndefined();
      expect(shell.activeSessionKey).toBe(mainKey);
    },
  );

  it("retires an externally observed batch once and shows one actionable cleanup failure", async () => {
    const { gatewayOwner: gatewayUrl } = recoveryOwner;
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const drafts = outbox(storage);
    drafts.write("retire me");
    const { shell } = recoveryShell({ sessionKeys: [], deletedSessionKeys: [deletedKey] });
    attachOwner(shell);
    const state = shell.runtime.context.sessions.state;
    shell.runtime.context.agents.state.agentsList = null;
    shell.runtime.context.gateway.snapshot.assistantAgentId = "main";
    const toast = toastHost();

    shell.observeDeletedSessions({
      ...state,
      deletedSessions: [],
    });
    await import("../lib/chat/composer-draft-retirement.runtime.ts");
    expect(drafts.read()).toContain("retire me");
    shell.observeDeletedSessions(state);
    shell.observeDeletedSessions(state);

    await vi.waitFor(() => {
      expect(
        storage.getItem(`openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`),
      ).toBeNull();
      drafts.expectRetired(state.deletedSessions[0]!.retireBeforeRevision);
      expect(toast.textContent).toContain(cleanupWarning);
    });
    expect(toast.querySelectorAll(".app-toast")).toHaveLength(1);
  });

  it.each([
    [mainKey, null],
    ["agent:main:existing-thread", "/chat/main/existing-thread"],
  ] as const)("recovers a failed route for %s", (key, pathname) => {
    const { replace, setSessionKey, shell } = recoveryShell({
      activeSessionKey: key,
      sessionKeys: [key],
      deletedSessionKeys: pathname ? [] : [key],
    });
    shell.recoverNotFoundRoute();
    expect(setSessionKey).not.toHaveBeenCalled();
    if (pathname) {
      expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname });
    } else {
      expect(replace).not.toHaveBeenCalled();
    }
  });

  it("rejects a late route commit for a session already marked deleted", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const { replace, setSessionKey, shell } = recoveryShell({
      deletedSessionKeys: [deletedKey],
      sessionKeys: [mainKey],
    });
    shell.didConsiderNativeRouteRestore = true;
    const routerState = committedRouterState("chat", "/chat/main/deleted-thread", {
      kind: "session",
      sessionKey: deletedKey,
    });

    shell.shellNavigation.updateRouteState(selectShellRouteState(routerState));

    expect(shell.activeSessionKey).toBe(mainKey);
    expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(mainKey);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
  });
});

it("projects only the ready recovery owner's attachment failures through the shell scope", () => {
  const storage = createStorageMock();
  vi.stubGlobal("sessionStorage", storage);
  const { shell } = recoveryShell();
  const context = shell.runtime.context;
  const { gateway } = context;
  context.agents.state.agentsList = null;
  const owner = {
    recoveryScope: "current-principal",
    recoveryScopeReady: false,
  };
  gateway.snapshot.client = owner as GatewayBrowserClient;
  gateway.snapshot.phase = "connected";
  const ownSessionKey = "agent:main:own-attachment";
  const otherSessionKey = "agent:main:other-attachment";
  const admittedHost = {
    settings: { gatewayUrl: gateway.connection.gatewayUrl },
    connected: true,
    client: { ...owner, recoveryScopeReady: true },
  };
  const target = storageTargetForComposer(admittedHost);
  writeStoredOutboxStore(storage, target, {
    version: 4,
    gatewayOwner: target.gatewayOwner,
    recovery: {},
    sessions: Object.fromEntries(
      Object.entries({
        [ownSessionKey]: owner.recoveryScope,
        [otherSessionKey]: "another-principal",
      }).map(([sessionKey, recoveryScope]) => [
        storedChatOutboxScopeKey({ sessionKey }),
        {
          updatedAt: 1,
          queue: [
            {
              id: sessionKey,
              text: "attachment failed",
              createdAt: 1,
              sendState: "failed",
              storageScope: outboxStorageScope({
                ...admittedHost,
                client: { recoveryScope, recoveryScopeReady: true },
              }),
              attachmentPayload: { key: sessionKey, recoveryScope, tabId: "tab" },
            },
          ],
        },
      ]),
    ),
  });
  const reader = createStoredChatOutboxReader();

  expect(reader.read(shell.storedOutboxScopeHost(context)).total).toBe(0);
  owner.recoveryScopeReady = true;
  const summary = reader.read(shell.storedOutboxScopeHost(context));
  expect(summary.total).toBe(1);
  expect(summary.attentionCountForSession(ownSessionKey)).toBe(1);
  expect(summary.attentionCountForSession(otherSessionKey)).toBe(0);
});
