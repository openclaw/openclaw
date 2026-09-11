import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import { talkModeHandlers } from "./server-methods/talk-mode.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

function createPendingProfileClient() {
  return {
    connId: "conn-pending-profile",
    authenticatedUserId: "mutable-login@github",
    connect: {
      role: "operator" as const,
      scopes: ["operator.admin"],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;
}

async function dispatchPendingProfileMethod(params: {
  client: NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;
  handler?: GatewayRequestHandler;
  method: string;
  requestParams?: unknown;
  methodRegistry?: ReturnType<typeof createGatewayMethodRegistry>;
  expectedProfileId?: string;
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `req-${params.method}`,
      method: params.method,
      params: params.requestParams ?? {},
      ...(params.expectedProfileId !== undefined
        ? { expectedProfileId: params.expectedProfileId }
        : {}),
    },
    respond,
    client: params.client,
    isWebchatConnect: () => false,
    context: {
      logGateway: { warn: vi.fn() },
      getRuntimeConfig: () => ({}),
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    ...(params.methodRegistry
      ? { methodRegistry: params.methodRegistry }
      : params.handler
        ? { extraHandlers: { [params.method]: params.handler } }
        : {}),
  });
  return respond;
}

describe("Gateway pending-profile authorization", () => {
  it.each([false, true])(
    "rechecks bound webchat talk.mode after node discovery (profile merged: %s)",
    async (merge) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const email = "talk-source@example.test";
        const source = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("talk-target@example.test");
        const client = createPendingProfileClient();
        client.connect.client = {
          id: "openclaw-control-ui",
          version: "test",
          platform: "web",
          mode: "webchat",
        };
        client.authenticatedUserProfile = {
          profileId: source.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: source.updatedAt,
        };
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const broadcast = vi.fn();
        const hasConnectedTalkNode = vi.fn(async () => {
          entered.resolve();
          await release.promise;
          return true;
        });
        const context = createDirectChatContext({ broadcast, hasConnectedTalkNode });
        const respond = vi.fn();
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: "bound-talk-mode",
            method: "talk.mode",
            expectedProfileId: source.id,
            params: { enabled: true, phase: "listening" },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => true,
          extraHandlers: talkModeHandlers,
        });
        try {
          await Promise.race([entered.promise, request]);
          expect(hasConnectedTalkNode).toHaveBeenCalledOnce();
          expect(respond).not.toHaveBeenCalled();
          expect(broadcast).not.toHaveBeenCalled();
          if (merge) {
            linkEmail(email, target.id);
          }
        } finally {
          release.resolve();
          await request;
        }
        if (merge) {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
            }),
          );
          expect(broadcast).not.toHaveBeenCalled();
        } else {
          const payload = { enabled: true, phase: "listening", ts: expect.any(Number) };
          expect(broadcast).toHaveBeenCalledExactlyOnceWith("talk.mode", payload, {
            dropIfSlow: true,
          });
          expect(respond).toHaveBeenCalledExactlyOnceWith(true, payload, undefined);
        }
        expect(client).not.toHaveProperty("invalidated", true);
      });
    },
  );

  it("keeps the actual settings writer unchanged when a selected account merges during preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("patch-source@example.test");
      const target = ensureProfileForEmail("patch-target@example.test");
      const scope = { agentId: "main", sessionKey: "agent:main:bound-patch" };
      await upsertSessionEntryCore(scope, {
        sessionId: "bound-patch-session",
        updatedAt: 1,
        label: "original",
      });
      const before = loadSessionEntry(scope);
      const client = createPendingProfileClient();
      client.authenticatedUserProfile = {
        profileId: source.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: source.updatedAt,
      };
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const respond = vi.fn();
      const context = createDirectChatContext();
      const request = handleGatewayRequest({
        req: {
          type: "req",
          id: "bound-patch",
          method: "sessions.patch",
          expectedProfileId: source.id,
          params: { key: scope.sessionKey, agentId: "main", label: "must not commit" },
        },
        client,
        respond,
        isWebchatConnect: () => false,
        context,
        extraHandlers: {
          "sessions.patch": async (options) => {
            entered.resolve();
            await release.promise;
            await sessionMutationHandlers["sessions.patch"]!(options);
          },
        },
      });
      try {
        await Promise.race([entered.promise, request]);
        expect(respond).not.toHaveBeenCalled();
        linkEmail("patch-source@example.test", target.id);
      } finally {
        release.resolve();
        await request;
      }
      expect(loadSessionEntry(scope)).toEqual(before);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
        }),
      );
      const accepted = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "current-patch",
          method: "sessions.patch",
          expectedProfileId: target.id,
          params: { key: scope.sessionKey, agentId: "main", label: "current account" },
        },
        client,
        context,
        respond: accepted,
        isWebchatConnect: () => false,
        extraHandlers: sessionMutationHandlers,
      });
      expect(accepted.mock.calls[0]?.[0]).toBe(true);
      expect(loadSessionEntry(scope)?.label).toBe("current account");
    });
  });

  it("resolves pending identity for an explicitly bound independent method", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("pending-binding@example.test");
      const client = createPendingProfileClient();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      client.authenticatedGitHubIdentitySync = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        return { profileId: profile.id, updatedAt: profile.updatedAt };
      });
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
      const request = dispatchPendingProfileMethod({
        client,
        handler,
        method: "status",
        expectedProfileId: profile.id,
      });
      try {
        await Promise.race([entered.promise, request]);
        expect(handler).not.toHaveBeenCalled();
        expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await request;
      }
      expect(await request).toHaveBeenCalledWith(true, { ok: true });
    });
  });

  it.each(["entry", "preparation", "invocation"] as const)(
    "rejects the exact selected profile after a real merge at %s",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const email = "selected-profile@example.test";
        const source = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("merged-profile@example.test");
        const client = createPendingProfileClient();
        client.authenticatedUserProfile = {
          profileId: source.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: source.updatedAt,
        };
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const handler = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
          if (phase === "invocation") {
            entered.resolve();
            await release.promise;
          }
          respond(
            true,
            { accountData: "must not publish" },
            {
              code: "UNAVAILABLE",
              message: "must not publish original error",
            },
          );
        });
        const lazy = createLazyCoreHandlers({
          methods: ["status"],
          loadHandlers: async () => {
            if (phase === "preparation") {
              entered.resolve();
              await release.promise;
            }
            return { status: handler };
          },
        });
        if (phase === "entry") {
          linkEmail(email, target.id);
        }
        const request = dispatchPendingProfileMethod({
          client,
          handler: lazy.status,
          method: "status",
          expectedProfileId: source.id,
        });
        try {
          if (phase !== "entry") {
            await Promise.race([entered.promise, request]);
            linkEmail(email, target.id);
          }
        } finally {
          release.resolve();
        }
        const respond = await request;
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: {
              reason: "EXPECTED_PROFILE_MISMATCH",
              execution: phase === "invocation" ? "may_have_executed" : "not_started",
            },
          }),
        );
        expect(handler).toHaveBeenCalledTimes(phase === "invocation" ? 1 : 0);
        expect(client).not.toHaveProperty("invalidated", true);
        const current = await dispatchPendingProfileMethod({
          client,
          handler: ({ respond: respondCurrent }) => respondCurrent(true, { ok: true }),
          method: "status",
          expectedProfileId: target.id,
        });
        expect(current).toHaveBeenCalledWith(true, { ok: true });
      });
    },
  );

  it.each(["chat.send", "models.list", "sessions.status"])(
    "waits for immutable profile attachment before %s dispatch",
    async (method) => {
      const deferred = createDeferredCore<{ profileId: string; updatedAt: number }>();
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn(async () => await deferred.promise);
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

      const request = dispatchPendingProfileMethod({
        client,
        handler,
        method,
        // chat.send requires a session target at the protocol level; the mutation
        // pipeline rejects targetless frames before profile-dependent dispatch.
        requestParams:
          method === "chat.send" ? { sessionKey: "agent:main:main" } : { agentId: "main" },
      });
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();

      client.authenticatedUserProfile = {
        profileId: "profile-canonical",
        displayName: "Canonical",
        hasAvatar: false,
        updatedAt: 1,
      };
      deferred.resolve({ profileId: "profile-canonical", updatedAt: 1 });

      await expect(request).resolves.toHaveBeenCalledWith(true, { ok: true });
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("returns retryable unavailability without dispatch and retries on the next request", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi
      .fn()
      .mockRejectedValueOnce(new Error("private provider detail"))
      .mockImplementationOnce(async () => {
        client.authenticatedUserProfile = {
          profileId: "profile-retried",
          displayName: "Retried",
          hasAvatar: false,
          updatedAt: 2,
        };
        return { profileId: "profile-retried", updatedAt: 2 };
      });
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const failed = await dispatchPendingProfileMethod({ client, handler, method: "agent" });
    expect(handler).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.not.stringContaining("private provider detail"),
        retryable: true,
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      }),
    );

    const retried = await dispatchPendingProfileMethod({ client, handler, method: "agent" });
    expect(handler).toHaveBeenCalledOnce();
    expect(retried).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
  });

  it("classifies profile-owned core families and plugin or auxiliary methods fail-closed", async () => {
    const methods = [
      "agent",
      "approval.resolve",
      "artifacts.list",
      "board.event",
      "chat.history",
      "chat.metadata",
      "controlUi.sessionPreview",
      "exec.approval.resolve",
      "mcp.app.view",
      "mentions.list",
      "mentions.dismiss",
      "message.action",
      "models.list",
      "openclaw.chat",
      "plugin.approval.resolve",
      "projects.list",
      "secrets.store.set",
      "send",
      "sessions.list",
      "sessions.status",
      "skills.library.list",
      "skills.library.read",
      "skills.library.save",
      "skills.library.mutate",
      "skills.library.activate",
      "skills.library.import",
      "skills.library.upload",
      "taskSuggestions.list",
      "tasks.list",
      "users.github.status",
      "users.github.authorize.start",
      "users.github.authorize.poll",
      "users.github.authorize.cancel",
      "users.github.disconnect",
      "users.mentionable",
    ];
    for (const method of methods) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
      const handler = vi.fn<GatewayRequestHandler>();
      const respond = await dispatchPendingProfileMethod({
        client,
        handler,
        method,
        requestParams:
          method === "skills.library.activate" ? { sessionKey: "agent:main:main" } : undefined,
      });
      expect(handler, method).not.toHaveBeenCalled();
      expect(respond, method).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      );
    }

    for (const owner of [
      { kind: "plugin" as const, pluginId: "identity-reader" },
      { kind: "aux" as const, area: "identity-reader" },
    ]) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
      const handler = vi.fn<GatewayRequestHandler>();
      const method = `${owner.kind}.identity.read`;
      const methodRegistry = createGatewayMethodRegistry([
        { name: method, handler, owner, scope: "operator.admin" },
      ]);
      await dispatchPendingProfileMethod({ client, handler, method, methodRegistry });
      expect(handler, owner.kind).not.toHaveBeenCalled();
    }
  });

  it("dispatches explicitly independent plugin status while profile sync is unavailable", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const method = "logbook.status";
    const methodRegistry = createGatewayMethodRegistry([
      {
        name: method,
        handler,
        owner: { kind: "plugin", pluginId: "logbook" },
        profileAccess: "independent",
        scope: "operator.read",
      },
    ]);

    const respond = await dispatchPendingProfileMethod({
      client,
      handler,
      method,
      methodRegistry,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).not.toHaveBeenCalled();
  });

  it("gates parameter-dependent incognito access without blocking ordinary independent requests", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const blocked = await dispatchPendingProfileMethod({
      client,
      handler,
      method: "question.request",
      requestParams: { sessionKey: "agent:main:dashboard:incognito-profile-gate" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );

    const allowed = await dispatchPendingProfileMethod({
      client,
      handler,
      method: "question.request",
      requestParams: { sessionKey: "agent:main:main" },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
  });

  it("keeps profile bootstrap and identity-independent status available while sync is pending", async () => {
    for (const method of ["users.self", "status"]) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn(
        () => new Promise<{ profileId: string; updatedAt: number }>(() => {}),
      );
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
      const methodRegistry = createGatewayMethodRegistry([
        {
          name: method,
          handler,
          owner: { kind: "core", area: "gateway" },
          profileAccess: "independent",
          scope: "operator.admin",
        },
      ]);

      const respond = await dispatchPendingProfileMethod({
        client,
        handler,
        method,
        methodRegistry,
      });

      expect(handler, method).toHaveBeenCalledOnce();
      expect(respond, method).toHaveBeenCalledWith(true, { ok: true });
      expect(client.authenticatedGitHubIdentitySync, method).not.toHaveBeenCalled();
    }
  });
});

describe("Gateway self-profile scope", () => {
  it("allows read-only users.self without anonymous access or profile writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const email = "reader@example.com";
      const profile = ensureProfileForEmail(email);
      const before = getUserProfileListItem(profile.id);
      const reader = createPendingProfileClient();
      reader.authenticatedUserId = email;
      reader.connect.scopes = ["operator.read"];
      const self = await dispatchPendingProfileMethod({ client: reader, method: "users.self" });

      const anonymous = createPendingProfileClient();
      delete anonymous.authenticatedUserId;
      anonymous.connect.scopes = ["operator.read"];
      const deniedRead = await dispatchPendingProfileMethod({
        client: anonymous,
        method: "users.self",
      });
      const deniedWrite = await dispatchPendingProfileMethod({
        client: reader,
        method: "users.setDisplayName",
        requestParams: { profileId: profile.id, displayName: "Not permitted" },
      });

      expect(deniedRead).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(deniedWrite).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.write",
            requiredScopes: ["operator.write"],
          },
        }),
      );
      expect(getUserProfileListItem(profile.id)).toEqual(before);
      expect(self).toHaveBeenCalledWith(true, {
        profile: expect.objectContaining({ id: profile.id, emails: [email] }),
      });
    });
  });
});
