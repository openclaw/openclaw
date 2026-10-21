import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import { linkEmail } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  createRequestGate,
  expectRejected,
  expectRejectedOnce,
} from "./server-methods.request-gate.test-support.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import * as sessionGroupCatalog from "./session-group-catalog.js";
import { talkModeHandlers } from "./talk/handlers/mode.js";

function profileIdentity(profile: { id: string; updatedAt: number }) {
  const { id: profileId, updatedAt } = profile;
  return { profileId, displayName: null, hasAvatar: false, updatedAt };
}

function createPendingProfileClient(scopes = ["operator.admin"]) {
  return {
    connId: "conn-pending-profile",
    authenticatedUserId: "mutable-login@github",
    connect: {
      role: "operator" as const,
      scopes,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;
}

async function dispatchProfile(
  client: NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>,
  method: string,
  params: {
    handler?: GatewayRequestHandler;
    requestParams?: unknown;
    methodRegistry?: ReturnType<typeof createGatewayMethodRegistry>;
    expectedProfileId?: string;
    context?: Parameters<typeof handleGatewayRequest>[0]["context"];
    respond?: Parameters<typeof handleGatewayRequest>[0]["respond"];
    webchat?: boolean;
  } = {},
) {
  const respond = params.respond ?? vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `req-${method}`,
      method,
      params: params.requestParams ?? {},
      ...(params.expectedProfileId !== undefined
        ? { expectedProfileId: params.expectedProfileId }
        : {}),
    },
    respond,
    client,
    isWebchatConnect: () => params.webchat ?? false,
    context:
      params.context ??
      ({
        logGateway: { warn: vi.fn() },
        getRuntimeConfig: () => ({}),
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"]),
    ...(params.methodRegistry
      ? { methodRegistry: params.methodRegistry }
      : params.handler
        ? { extraHandlers: { [method]: params.handler } }
        : {}),
  });
  return respond;
}

function selectedProfile(email: string) {
  const source = ensureProfileForEmail(email);
  const target = ensureProfileForEmail(`merged-${email}`);
  const client = createPendingProfileClient();
  client.authenticatedUserProfile = profileIdentity(source);
  return { source, target, client };
}

describe("Gateway pending-profile authorization", () => {
  it.each([
    ["models.list", SESSION_READ_SCOPE, SESSION_READ_SCOPE],
    ["models.list", READ_SCOPE, READ_SCOPE],
    ["models.list", READ_SCOPE, SESSION_READ_SCOPE],
    ["models.list", SESSION_READ_SCOPE, READ_SCOPE],
    ["sessions.groups.list", SESSION_READ_SCOPE, SESSION_READ_SCOPE],
    ["sessions.groups.list", READ_SCOPE, READ_SCOPE],
    ["sessions.groups.list", READ_SCOPE, SESSION_READ_SCOPE],
    ["sessions.groups.list", SESSION_READ_SCOPE, READ_SCOPE],
  ])(
    "retains %s admission through awaited preparation (%s -> %s)",
    async (method, initial, current) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = ensureProfileForEmail("catalog-reader@example.test");
        const client = createPendingProfileClient([initial]);
        using gate = createRequestGate();
        const admittedScopes: Array<string | undefined> = [];
        const handler = vi.fn<GatewayRequestHandler>((options) => {
          admittedScopes.push(readGatewayRequestMutationAuthority(options).sessionScope);
          options.respond(true, { ok: true });
        });
        const identity = profileIdentity(profile);
        const groupRead = method === "sessions.groups.list";
        const ensureCatalog = sessionGroupCatalog.ensureSessionGroupCatalog;
        using catalogPreparation = groupRead
          ? vi
              .spyOn(sessionGroupCatalog, "ensureSessionGroupCatalog")
              .mockImplementation(async (env) => {
                await ensureCatalog(env);
                await gate.pause();
              })
          : undefined;
        if (groupRead) {
          client.authenticatedUserProfile = identity;
        }
        client.authenticatedGitHubIdentitySync = vi.fn(async () => {
          await gate.pause();
          client.authenticatedUserProfile = identity;
          return { profileId: profile.id, updatedAt: profile.updatedAt };
        });
        const pending = dispatchProfile(client, method, { handler });
        await gate.during(pending, () => {
          expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(groupRead ? 0 : 1);
          if (groupRead) {
            expect(catalogPreparation).toHaveBeenCalledOnce();
          }
          expect(handler).not.toHaveBeenCalled();
          client.connect.scopes = [current];
        });
        const response = await pending;
        if (initial === current) {
          expect(response).toHaveBeenCalledExactlyOnceWith(true, { ok: true });
          expect(admittedScopes).toEqual([
            initial === SESSION_READ_SCOPE ? SESSION_READ_SCOPE : undefined,
          ]);
        } else {
          expect(handler).not.toHaveBeenCalled();
          expectRejectedOnce(response, {
            code: "FORBIDDEN",
            message: "Gateway requester authority changed",
          });
        }
      });
    },
  );

  it("requires a verified person only when the request uses narrow session admission", async () => {
    const client = createPendingProfileClient([SESSION_READ_SCOPE]);
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { sessions: [] }));
    const denied = await dispatchProfile(client, "sessions.list", { handler });
    expectRejected(denied, "FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();

    client.connect.scopes = ["operator.read"];
    const broad = await dispatchProfile(client, "sessions.list", { handler });
    expect(broad).toHaveBeenCalledWith(true, { sessions: [] });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "rechecks bound webchat talk.mode after node discovery (profile merged: %s)",
    async (merge) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const email = "talk-source@example.test";
        const { source, target, client } = selectedProfile(email);
        client.connect.client = {
          id: "openclaw-control-ui",
          version: "test",
          platform: "web",
          mode: "webchat",
        };
        using gate = createRequestGate();
        const broadcast = vi.fn();
        const hasConnectedTalkNode = vi.fn(async () => {
          await gate.pause();
          return true;
        });
        const context = createDirectChatContext({ broadcast, hasConnectedTalkNode });
        const respond = vi.fn();
        const request = dispatchProfile(client, "talk.mode", {
          expectedProfileId: source.id,
          requestParams: { enabled: true, phase: "listening" },
          context,
          respond,
          webchat: true,
          handler: talkModeHandlers["talk.mode"],
        });
        await gate.during(request, () => {
          expect(hasConnectedTalkNode).toHaveBeenCalledOnce();
          expect(respond).not.toHaveBeenCalled();
          expect(broadcast).not.toHaveBeenCalled();
          if (merge) {
            linkEmail(email, target.id);
          }
        });
        if (merge) {
          expectRejectedOnce(respond, {
            details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
          });
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
      setRuntimeConfigSnapshot({});
      const { source, target, client } = selectedProfile("patch-source@example.test");
      const scope = { agentId: "main", sessionKey: "agent:main:bound-patch" };
      await upsertSessionEntryCore(scope, {
        sessionId: "bound-patch-session",
        updatedAt: 1,
        label: "original",
      });
      const before = loadSessionEntry(scope);
      using gate = createRequestGate();
      const respond = vi.fn();
      const context = createDirectChatContext();
      const request = dispatchProfile(client, "sessions.patch", {
        expectedProfileId: source.id,
        requestParams: { key: scope.sessionKey, agentId: "main", label: "must not commit" },
        context,
        respond,
        handler: async (options) => {
          await gate.pause();
          await sessionMutationHandlers["sessions.patch"]!(options);
        },
      });
      await gate.during(request, () => {
        expect(respond).not.toHaveBeenCalled();
        linkEmail("patch-source@example.test", target.id);
      });
      expect(loadSessionEntry(scope)).toEqual(before);
      expectRejected(respond, {
        details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
      });
      const accepted = vi.fn();
      await dispatchProfile(client, "sessions.patch", {
        expectedProfileId: target.id,
        requestParams: { key: scope.sessionKey, agentId: "main", label: "current account" },
        context,
        respond: accepted,
        handler: sessionMutationHandlers["sessions.patch"],
      });
      expect(accepted.mock.calls[0]?.[0]).toBe(true);
      expect(loadSessionEntry(scope)?.label).toBe("current account");
    });
  });

  it.each(["entry", "preparation", "invocation"] as const)(
    "rejects the exact selected profile after a real merge at %s",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const email = "selected-profile@example.test";
        const { source, target, client } = selectedProfile(email);
        using gate = createRequestGate();
        const handler = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
          if (phase === "invocation") {
            await gate.pause();
          }
          respond(
            true,
            { accountData: "must not publish" },
            { code: "UNAVAILABLE", message: "must not publish original error" },
          );
        });
        const lazy = createLazyCoreHandlers({
          methods: ["status"],
          loadHandlers: async () => {
            if (phase === "preparation") {
              await gate.pause();
            }
            return { status: handler };
          },
        });
        if (phase === "entry") {
          linkEmail(email, target.id);
        }
        const request = dispatchProfile(client, "status", {
          handler: lazy.status,
          expectedProfileId: source.id,
        });
        if (phase !== "entry") {
          await gate.during(request, () => {
            linkEmail(email, target.id);
          });
        }
        const respond = await request;
        expectRejectedOnce(respond, {
          code: "INVALID_REQUEST",
          details: {
            reason: "EXPECTED_PROFILE_MISMATCH",
            execution: phase === "invocation" ? "may_have_executed" : "not_started",
          },
        });
        expect(handler).toHaveBeenCalledTimes(phase === "invocation" ? 1 : 0);
        expect(client).not.toHaveProperty("invalidated", true);
        const current = await dispatchProfile(client, "status", {
          handler: ({ respond: respondCurrent }) => respondCurrent(true, { ok: true }),
          expectedProfileId: target.id,
        });
        expect(current).toHaveBeenCalledWith(true, { ok: true });
      });
    },
  );

  it.each(["status", "chat.send"] as const)(
    "waits for immutable profile attachment before %s",
    async (method) => {
      const run = async () => {
        const bound = method === "status";
        const profile = bound
          ? ensureProfileForEmail("pending-binding@example.test")
          : { id: "profile-canonical", updatedAt: 1 };
        const client = createPendingProfileClient();
        using gate = createRequestGate();
        client.authenticatedGitHubIdentitySync = vi.fn(async () => {
          await gate.pause();
          if (bound) {
            client.authenticatedUserProfile = profileIdentity(profile);
          }
          return { profileId: profile.id, updatedAt: profile.updatedAt };
        });
        const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
        const request = dispatchProfile(client, method, {
          handler,
          ...(bound
            ? { expectedProfileId: profile.id }
            : { requestParams: { sessionKey: "agent:main:main" } }),
        });
        await gate.during(request, () => {
          expect(handler).not.toHaveBeenCalled();
          expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
          if (!bound) {
            client.authenticatedUserProfile = {
              ...profileIdentity(profile),
              displayName: "Canonical",
            };
          }
        });
        expect(await request).toHaveBeenCalledWith(true, { ok: true });
        expect(handler).toHaveBeenCalledOnce();
      };
      if (method === "status") {
        await withOpenClawTestState({ scenario: "minimal" }, run);
      } else {
        await run();
      }
    },
  );

  it("returns retryable unavailability without dispatch and retries on the next request", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi
      .fn()
      .mockRejectedValueOnce(new Error("private provider detail"))
      .mockImplementationOnce(async () => {
        client.authenticatedUserProfile = profileIdentity({ id: "profile-retried", updatedAt: 2 });
        return { profileId: "profile-retried", updatedAt: 2 };
      });
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const failed = await dispatchProfile(client, "agent", { handler });
    expect(handler).not.toHaveBeenCalled();
    expectRejected(failed, {
      code: "UNAVAILABLE",
      message: expect.not.stringContaining("private provider detail"),
      retryable: true,
      details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
    });

    const retried = await dispatchProfile(client, "agent", { handler });
    expect(handler).toHaveBeenCalledOnce();
    expect(retried).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
  });

  it("classifies profile-owned core families and plugin or auxiliary methods fail-closed", async () => {
    const methods = [
      "agent approval.resolve artifacts.list board.event chat.history chat.metadata",
      "controlUi.sessionPreview exec.approval.resolve mcp.app.view mentions.list mentions.dismiss",
      "message.action models.list openclaw.chat plugin.approval.resolve projects.list secrets.store.set send sessions.list",
      "skills.library.list skills.library.read skills.library.save skills.library.mutate",
      "skills.library.activate skills.library.import skills.library.upload taskSuggestions.list",
      "users.github.status users.github.authorize.start users.github.authorize.poll",
      "users.github.authorize.cancel users.github.disconnect users.mentionable",
    ].flatMap((group) => group.split(" "));
    for (const method of methods) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
      const handler = vi.fn<GatewayRequestHandler>();
      const respond = await dispatchProfile(client, method, {
        handler,
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
  });

  it("keeps plugin and auxiliary profile access fail-closed unless explicitly independent", async () => {
    for (const owner of [
      { kind: "plugin" as const, pluginId: "identity-reader" },
      { kind: "aux" as const, area: "identity-reader" },
      { kind: "plugin" as const, pluginId: "logbook" },
    ]) {
      const independent = owner.kind === "plugin" && owner.pluginId === "logbook";
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
      const handler = independent
        ? vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }))
        : vi.fn<GatewayRequestHandler>();
      const method = independent ? "logbook.status" : `${owner.kind}.identity.read`;
      const methodRegistry = createGatewayMethodRegistry([
        {
          name: method,
          handler,
          owner,
          scope: independent ? "operator.read" : "operator.admin",
          ...(independent ? { profileAccess: "independent" as const } : {}),
        },
      ]);
      const respond = await dispatchProfile(client, method, { handler, methodRegistry });
      expect(handler).toHaveBeenCalledTimes(independent ? 1 : 0);
      if (independent) {
        expect(respond).toHaveBeenCalledWith(true, { ok: true });
        expect(client.authenticatedGitHubIdentitySync).not.toHaveBeenCalled();
      }
    }
  });

  it("gates parameter-dependent incognito access without blocking ordinary independent requests", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const blocked = await dispatchProfile(client, "question.request", {
      handler,
      requestParams: { sessionKey: "agent:main:dashboard:incognito-profile-gate" },
    });
    expect(handler).not.toHaveBeenCalled();
    expectRejected(blocked, { code: "UNAVAILABLE", retryable: true });

    const allowed = await dispatchProfile(client, "question.request", {
      handler,
      requestParams: { sessionKey: "agent:main:main" },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
  });
  it("allows read-only users.self without anonymous access or profile writes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const email = "reader@example.com";
      const profile = ensureProfileForEmail(email);
      const before = getUserProfileListItem(profile.id);
      const reader = createPendingProfileClient([READ_SCOPE]);
      reader.authenticatedUserId = email;
      const sql = observeHostDataSql();
      const self = await dispatchProfile(reader, "users.self").finally(sql.restore);
      const profileQueries = sql.queries.filter((s) =>
        /\buser_profile(?:s|_emails|_identities)\b/u.test(s),
      );
      expect(profileQueries).toEqual([]);

      const anonymous = createPendingProfileClient([READ_SCOPE]);
      delete anonymous.authenticatedUserId;
      const deniedRead = await dispatchProfile(anonymous, "users.self");
      const deniedWrite = await dispatchProfile(reader, "users.setDisplayName", {
        requestParams: { profileId: profile.id, displayName: "Not permitted" },
      });

      expectRejected(deniedRead, "FORBIDDEN");
      expectRejected(deniedWrite, {
        code: "FORBIDDEN",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.write",
          requiredScopes: ["operator.write"],
        },
      });
      expect(getUserProfileListItem(profile.id)).toEqual(before);
      expect(self).toHaveBeenCalledWith(true, {
        profile: expect.objectContaining({ id: profile.id, emails: [email] }),
      });
    });
  });
});
