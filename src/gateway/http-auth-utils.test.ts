import { getEventListeners, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  authorizeGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const { authorize, ensureOwner } = vi.hoisted(() => ({ authorize: vi.fn(), ensureOwner: vi.fn() }));
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  authorizeHttpGatewayConnect: authorize,
}));
vi.mock("../infra/host-account-name.js", () => ({
  resolveHostAccountName: async () => "Gateway Person",
}));
vi.mock("../state/user-profile-writes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/user-profile-writes.js")>();
  ensureOwner.mockImplementation(actual.ensureCanonicalGatewayOwnerProfile);
  return { ...actual, ensureCanonicalGatewayOwnerProfile: ensureOwner };
});

const roles = {
  default: "reader",
  definitions: { reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] } },
} satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;

async function authenticate(
  method: GatewayAuthResult["method"],
  cfg: OpenClawConfig = {},
  user?: string,
) {
  setRuntimeConfigSnapshot(cfg);
  authorize.mockResolvedValueOnce({ ok: true, method, ...(user ? { user } : {}) });
  return checkGatewayHttpRequestAuth({
    req,
    auth: { mode: "none", allowTailscale: false },
    cfg,
    getRuntimeConfig: () => cfg,
  });
}

async function admitResponse(response: ReturnType<typeof makeMockHttpResponse>, email: string) {
  authorize.mockResolvedValueOnce({ ok: true, method: "trusted-proxy", user: email });
  const admitted = await authorizeGatewayHttpRequestOrReply({
    req: response.res.req,
    res: response.res,
    auth: { mode: "none", allowTailscale: false },
  });
  if (!admitted?.operatorAccessAuthority) {
    throw new Error("Expected admitted response access");
  }
  return admitted.operatorAccessAuthority;
}

async function completeResponseCapture(email: string) {
  const response = makeMockHttpResponse();
  try {
    const authority = await admitResponse(response, email);
    const references = {
      authority: new WeakRef(authority),
      assertion: new WeakRef(authority.assertCurrent),
      signal: new WeakRef(authority.signal),
    };
    const finished = once(response.res, "finish");
    response.res.end();
    await finished;
    return references;
  } finally {
    response.res.destroy();
  }
}

function registerPersonAccessFixture() {
  const { config, registry } = createPluginRegistryFixture();
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        ...roles,
        definitions: {
          ...roles.definitions,
          reader: { ...roles.definitions.reader, accessPolicyPlugin: "person-access" },
          staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        },
      },
    },
  };
  const email = "visitor@example.test";
  const person = ensureProfileForEmail(email);
  const access: { grant?: AbortController; inapplicable?: boolean; onAuthorize?: () => void } = {};
  registerVirtualTestPlugin({
    registry,
    config,
    id: "person-access",
    name: "Person access",
    register(api) {
      api.registerGatewayAccessPolicy({
        authorize({ profile }) {
          access.onAuthorize?.();
          if (profile.assignedRole === "staff" || access.inapplicable) {
            return undefined;
          }
          const current = access.grant;
          if (!current || !profile.emails.includes(email)) {
            throw new Error("Current access required");
          }
          return {
            signal: current.signal,
            assertCurrent: () => current.signal.throwIfAborted(),
          };
        },
      });
    },
  });
  setActivePluginRegistry(registry.registry);
  return { cfg, email, person, access, registry: registry.registry };
}

describe("HTTP gateway owner profiles", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
  });

  it.each(["missing", "disabled", "failed", "unregistered", "inapplicable", "unrelated"] as const)(
    "denies a required %s policy while preserving independent staff and owner access",
    async (availability) => {
      await withOpenClawTestState({ label: "http-required-access-policy" }, async () => {
        const { cfg, email, person, access, registry } = registerPersonAccessFixture();
        access.grant = new AbortController();
        const plugin = registry.plugins.find((entry) => entry.id === "person-access");
        if (!plugin) {
          throw new Error("Expected the registered access policy owner");
        }
        if (availability === "missing") {
          registry.plugins.length = 0;
          registry.gatewayAccessPolicies.length = 0;
        } else if (availability === "disabled") {
          plugin.enabled = false;
        } else if (availability === "failed") {
          plugin.status = "error";
        } else if (availability === "unregistered") {
          registry.gatewayAccessPolicies.length = 0;
        } else if (availability === "inapplicable") {
          access.inapplicable = true;
        } else {
          cfg.gateway!.roles!.definitions.reader!.accessPolicyPlugin = "another-policy";
        }

        for (const assignment of [null, "reader", "removed-role"]) {
          setUserProfileRole(person.id, assignment);
          invalidateOperatorRolePolicy(person.id);
          expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject({
            ok: false,
            authResult: { reason: "operator_access_denied" },
          });
        }
        setUserProfileRole(person.id, "staff");
        invalidateOperatorRolePolicy(person.id);
        expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject({ ok: true });
        expect(await authenticate("token", cfg)).toMatchObject({ ok: true });
      });
    },
  );

  it.each(["grant ended", "email moved away and back"])(
    "enforces registered person access without retiring independent staff authority (%s)",
    async (change) => {
      await withOpenClawTestState({ label: "http-person-access" }, async () => {
        const { cfg, email, person, access } = registerPersonAccessFixture();
        expect((await authenticate("trusted-proxy", cfg, email)).ok).toBe(false);
        access.grant = new AbortController();
        const admitted = await authenticate("trusted-proxy", cfg, email);
        if (!admitted.ok || !admitted.requestAuth.operatorAccessAuthority) {
          throw new Error("Expected admitted person access");
        }
        const captured = admitted.requestAuth.operatorAccessAuthority;
        setDisplayName(person.id, "Updated display");
        const staffEmail = "another-verified@example.test";
        linkEmail(staffEmail, person.id);
        expect(() => captured.assertCurrent()).not.toThrow();
        setUserProfileRole(person.id, "staff");
        invalidateOperatorRolePolicy(person.id);
        const staff = await authenticate("trusted-proxy", cfg, email);
        expect(staff).toMatchObject({ ok: true });
        if (!staff.ok) {
          throw new Error("Expected independent staff admission");
        }
        expect(staff.requestAuth.operatorAccessAuthority).toBeUndefined();
        if (change === "grant ended") {
          access.grant.abort(new Error("Access ended"));
        } else {
          linkEmail(email, ensureProfileForEmail("replacement@example.test").id);
          linkEmail(email, person.id);
        }
        expect(captured.signal.aborted).toBe(true);
        expect(() => captured.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
        expect((await authenticate("trusted-proxy", cfg, staffEmail)).ok).toBe(true);
        access.grant = new AbortController();
        expect(() => captured.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
        expect((await authenticate("token", cfg)).ok).toBe(true);
      });
    },
  );

  it.each([false, true])(
    "rejects alias retirement during policy authorization (restored: %s)",
    async (restore) => {
      await withOpenClawTestState({ label: "http-reentrant-person-access" }, async () => {
        const { cfg, email, person, access } = registerPersonAccessFixture();
        linkEmail("retained@example.test", person.id);
        const replacement = ensureProfileForEmail("replacement@example.test");
        access.grant = new AbortController();
        access.onAuthorize = () => {
          linkEmail(email, replacement.id);
          if (restore) {
            linkEmail(email, person.id);
          }
        };
        expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject({
          ok: false,
          authResult: { reason: "operator_access_denied" },
        });
        expect(getUserProfileListItem(person.id).id).toBe(person.id);
        expect(access.grant.signal.aborted).toBe(false);
      });
    },
  );

  it.each(["grant", "alias"])(
    "collects HTTP captures while a retained signal observes %s retirement",
    async (source) => {
      await withOpenClawTestState({ label: "http-access-retention" }, async () => {
        const { cfg, email, person, access } = registerPersonAccessFixture();
        setRuntimeConfigSnapshot(cfg);
        linkEmail("retained@example.test", person.id);
        const replacement = ensureProfileForEmail("replacement@example.test");
        access.grant = new AbortController();
        const retired = await completeResponseCapture(email);
        const signal = await authenticate("trusted-proxy", cfg, email).then((admitted) => {
          if (!admitted.ok || !admitted.requestAuth.operatorAccessAuthority) {
            throw new Error("Expected retained access signal");
          }
          return admitted.requestAuth.operatorAccessAuthority.signal;
        });
        const control = new WeakRef({ unowned: true });
        // Leave the creation job before collecting; dereferencing first would retain the capture.
        await nextTurn();
        queryObjects(WeakRef);
        expect(control.deref()).toBeUndefined();
        for (const [name, reference] of Object.entries(retired)) {
          expect(reference.deref(), `completed HTTP ${name} should collect`).toBeUndefined();
        }
        expect(access.grant.signal.aborted).toBe(false);
        setDisplayName(person.id, "Still authorized");
        expect(signal.aborted).toBe(false);
        if (source === "grant") {
          access.grant.abort(new Error("Access ended"));
        } else {
          linkEmail(email, replacement.id);
          linkEmail(email, person.id);
        }
        expect(signal.aborted).toBe(true);
      });
    },
  );

  it("binds revocation to an active response and releases completed keep-alive responses", async () => {
    await withOpenClawTestState({ label: "http-response-access" }, async () => {
      const { cfg, email, person, access } = registerPersonAccessFixture();
      setRuntimeConfigSnapshot(cfg);
      linkEmail("retained@example.test", person.id);
      const replacement = ensureProfileForEmail("replacement@example.test");
      const streaming = makeMockHttpResponse();
      const completed = makeMockHttpResponse();
      const next = makeMockHttpResponse();
      const aliasStreaming = makeMockHttpResponse();
      const keepAliveSocket = completed.res.req.socket;
      Object.assign(completed.res, { socket: keepAliveSocket });
      Object.assign(next.res.req, { socket: keepAliveSocket });
      Object.assign(next.res, { socket: keepAliveSocket });
      let releaseRun: (() => void) | undefined;
      let releaseChild: (() => void) | undefined;
      try {
        access.grant = new AbortController();
        await admitResponse(streaming, email);
        expect(streaming.res.destroyed).toBe(false);
        access.grant.abort(new Error("Access ended"));
        expect(streaming.res.destroyed).toBe(true);

        const completedGrant = new AbortController();
        access.grant = completedGrant;
        const completedAuthority = await admitResponse(completed, email);
        expect(getEventListeners(completedAuthority.signal, "abort").length).toBeGreaterThan(0);
        const finished = once(completed.res, "finish");
        completed.res.end();
        await finished;
        expect(getEventListeners(completedAuthority.signal, "abort")).toEqual([]);

        access.grant = new AbortController();
        const nextAuthority = await admitResponse(next, email);
        completedGrant.abort(new Error("Previous invitation ended"));
        expect(completedAuthority.signal.aborted).toBe(true);
        expect(nextAuthority.signal.aborted).toBe(false);
        expect(() => nextAuthority.assertCurrent()).not.toThrow();
        expect(next.res.destroyed).toBe(false);
        expect(keepAliveSocket.destroyed).toBe(false);

        await admitResponse(aliasStreaming, email);
        // The child keeps its source after the parent releases it and its response disconnects.
        const captured = captureGatewayOperatorRunAuthority({
          client: {
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: { id: "test", version: "test", platform: "test", mode: "test" },
              role: "operator",
              scopes: ["operator.read"],
            },
            internal: { operatorRoleActor: { kind: "operator", profileId: person.id } },
          },
          context: { getRuntimeConfig: () => cfg },
          sourceAuthority: nextAuthority,
        });
        releaseRun = captured?.release;
        if (!captured?.authority.retain) {
          throw new Error("Expected retained operator source");
        }
        releaseChild = captured.authority.retain();
        captured.release();
        const disconnected = once(next.res, "close");
        next.res.destroy();
        await disconnected;
        expect(nextAuthority.signal.aborted).toBe(false);
        expect(captured.authority.signal?.aborted).toBe(false);
        setDisplayName(person.id, "Updated during retained work");
        linkEmail("added@example.test", person.id);
        expect(aliasStreaming.res.destroyed).toBe(false);
        expect(captured.authority.signal?.aborted).toBe(false);

        linkEmail(email, replacement.id);
        linkEmail(email, person.id);
        expect(aliasStreaming.res.destroyed).toBe(true);
        expect(captured.authority.signal?.aborted).toBe(true);
        expect(nextAuthority.signal.aborted).toBe(true);
        expect(access.grant.signal.aborted).toBe(false);
        expect((await authenticate("trusted-proxy", cfg, email)).ok).toBe(true);
        expect(nextAuthority.signal.aborted).toBe(true);
      } finally {
        releaseChild?.();
        releaseRun?.();
        streaming.res.destroy();
        completed.res.destroy();
        next.res.destroy();
        aliasStreaming.res.destroy();
      }
    });
  });

  it("shares the durable owner across auth methods and preserves an edited name", async () => {
    await withOpenClawTestState({ label: "http-owner-profile" }, async () => {
      let profileId: string | undefined;
      for (const method of ["token", "password", "device-token", "none"] as const) {
        const result = await authenticate(method);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.user).toBeUndefined();
        expect(result.requestAuth.authenticatedUserProfile).toMatchObject({
          displayName: profileId ? "Saved Owner" : "Gateway Person",
        });
        const currentId = result.requestAuth.authenticatedUserProfile!.profileId;
        if (profileId) {
          expect(currentId).toBe(profileId);
        } else {
          profileId = currentId;
          setDisplayName(profileId, "Saved Owner");
        }
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
      }
    });
  });

  it.each(["token", "password"] as const)(
    "keeps %s owner authority with configured roles",
    async (method) => {
      await withOpenClawTestState({ label: "http-owner-roles" }, async () => {
        const result = await authenticate(method, { gateway: { roles } });
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("expected authenticated request");
        }
        expect(result.requestAuth.authenticatedUserProfile).toBeDefined();
        expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
        expect(result.requestAuth.trustDeclaredOperatorScopes).toBe(false);
        expect(resolveSharedSecretHttpOperatorScopes(req, result.requestAuth)).toContain(
          "operator.admin",
        );
      });
    },
  );

  it.each(["none", "device-token"] as const)(
    "keeps configured-role %s requests without identity denied",
    async (method) => {
      expect(await authenticate(method, { gateway: { roles } })).toEqual({
        ok: false,
        authResult: { ok: false, reason: "user_profile_unavailable" },
      });
      expect(ensureOwner).not.toHaveBeenCalled();
    },
  );

  it("preserves a verified user's profile and role ceiling", async () => {
    await withOpenClawTestState({ label: "http-identified-profile" }, async () => {
      const result = await authenticate(
        "trusted-proxy",
        { gateway: { roles } },
        "alice@example.test",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected authenticated request");
      }
      expect(result.requestAuth.user).toBe("alice@example.test");
      expect(result.requestAuth.authenticatedUserProfile?.displayName).toBe("alice");
      expect(result.requestAuth.operatorRolePolicy?.scopes).toEqual(["operator.read"]);
      expect(ensureOwner).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "continues unidentified after owner storage failure (roles=%s)",
    async (configured) => {
      ensureOwner.mockImplementationOnce(() => {
        throw new Error("profile storage unavailable");
      });
      const result = await authenticate("token", configured ? { gateway: { roles } } : {});
      expect(result).toMatchObject({ ok: true, requestAuth: { authMethod: "token" } });
      if (!result.ok) {
        throw new Error("expected authenticated request");
      }
      expect(result.requestAuth.authenticatedUserProfile).toBeUndefined();
      expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
    },
  );
});
