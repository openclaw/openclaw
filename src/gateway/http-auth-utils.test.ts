import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getUserProfileListItem } from "../state/user-profile-list-item.test-support.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { linkEmail, setDisplayName } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  authorizeControlUiSessionOwnerReadRequestOrReply,
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
  authorizeControlUiReadHttpGatewayConnect: authorize,
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
const noAuth = { mode: "none" as const, allowTailscale: false };
const accessDenied = { ok: false, authResult: { reason: "operator_access_denied" } };

async function authenticate(
  method: GatewayAuthResult["method"],
  cfg: OpenClawConfig = {},
  user?: string,
) {
  setRuntimeConfigSnapshot(cfg);
  authorize.mockResolvedValueOnce({ ok: true, method, ...(user ? { user } : {}) });
  return checkAuth(cfg);
}

function checkAuth(cfg: OpenClawConfig) {
  return checkGatewayHttpRequestAuth({ req, auth: noAuth, cfg, getRuntimeConfig: () => cfg });
}

async function admitResponse(response: ReturnType<typeof makeMockHttpResponse>, email: string) {
  authorize.mockResolvedValueOnce({ ok: true, method: "trusted-proxy", user: email });
  const admitted = await authorizeGatewayHttpRequestOrReply({
    req: response.res.req,
    res: response.res,
    auth: noAuth,
  });
  assert(admitted?.operatorAccessAuthority, "Expected admitted response access");
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

async function registerPersonAccessFixture() {
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
  const person = await ensureCanonicalUserProfileForEmail(email);
  const catalog = await prepareUserProfileCatalog();
  onTestFinished(catalog.release);
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
          return { signal: current.signal, assertCurrent: () => current.signal.throwIfAborted() };
        },
      });
    },
  });
  setActivePluginRegistry(registry.registry);
  return { cfg, email, person, access, registry: registry.registry };
}

function inState<T extends unknown[]>(run: (...args: T) => Promise<void>) {
  return (...args: T) => withOpenClawTestState({ label: "http-auth" }, () => run(...args));
}

describe("HTTP gateway owner profiles", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
  });

  it(
    "reuses admitted state schema across 200 HTTP profile authorizations",
    inState(async () => {
      const { cfg, email, person, access } = await registerPersonAccessFixture();
      access.grant = new AbortController();
      expect((await authenticate("trusted-proxy", cfg, email)).ok).toBe(true);
      const observation = observeSqliteReadSql(StatementSync.prototype);
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      try {
        for (let index = 0; index < 200; index += 1) {
          authorize.mockResolvedValueOnce({ ok: true, method: "trusted-proxy", user: email });
          const result = await checkAuth(cfg);
          assert(result.ok);
          expect(result.requestAuth.authenticatedUserProfile?.profileId).toBe(person.id);
        }
        const reads = (pattern: RegExp) => observation.queries.filter((sql) => pattern.test(sql));
        expect(
          exec.mock.calls.filter(([sql]) => /CREATE TABLE IF NOT EXISTS user_profiles/iu.test(sql)),
        ).toHaveLength(0);
        expect(
          reads(/sqlite_schema|sqlite_master|pragma_table_info|PRAGMA user_version/iu),
        ).toHaveLength(0);
        expect(
          reads(/^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu).length,
        ).toBeLessThanOrEqual(1000);
      } finally {
        observation.restore();
        exec.mockRestore();
      }
    }),
  );

  it.each(["missing", "disabled", "failed", "unregistered", "inapplicable", "unrelated"] as const)(
    "denies a required %s policy while preserving independent staff and owner access",
    inState(async (availability: string) => {
      const { cfg, email, person, access, registry } = await registerPersonAccessFixture();
      access.grant = new AbortController();
      const plugin = registry.plugins.find((entry) => entry.id === "person-access");
      assert(plugin, "Expected the registered access policy owner");
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
        await setCanonicalUserProfileRole(person.id, assignment);
        invalidateOperatorRolePolicy(person.id);
        expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject(accessDenied);
      }
      await setCanonicalUserProfileRole(person.id, "staff");
      invalidateOperatorRolePolicy(person.id);
      expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject({ ok: true });
      expect(await authenticate("token", cfg)).toMatchObject({ ok: true });
    }),
  );

  it.each(["grant ended", "email moved away and back"])(
    "enforces registered person access without retiring independent staff authority (%s)",
    inState(async (change: string) => {
      const { cfg, email, person, access } = await registerPersonAccessFixture();
      expect((await authenticate("trusted-proxy", cfg, email)).ok).toBe(false);
      access.grant = new AbortController();
      const admitted = await authenticate("trusted-proxy", cfg, email);
      assert(admitted.ok && admitted.requestAuth.operatorAccessAuthority);
      const captured = admitted.requestAuth.operatorAccessAuthority;
      setDisplayName(person.id, "Updated display");
      const staffEmail = "another-verified@example.test";
      await linkCanonicalUserProfileEmail(staffEmail, person.id);
      expect(() => captured.assertCurrent()).not.toThrow();
      await setCanonicalUserProfileRole(person.id, "staff");
      invalidateOperatorRolePolicy(person.id);
      const staff = await authenticate("trusted-proxy", cfg, email);
      expect(staff).toMatchObject({ ok: true });
      assert(staff.ok, "Expected independent staff admission");
      expect(staff.requestAuth.operatorAccessAuthority).toBeNull();
      if (change === "grant ended") {
        access.grant.abort(new Error("Access ended"));
      } else {
        await linkCanonicalUserProfileEmail(
          email,
          (await ensureCanonicalUserProfileForEmail("replacement@example.test")).id,
        );
        await linkCanonicalUserProfileEmail(email, person.id);
      }
      expect(captured.signal.aborted).toBe(true);
      expect(() => captured.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
      expect((await authenticate("trusted-proxy", cfg, staffEmail)).ok).toBe(true);
      access.grant = new AbortController();
      expect(() => captured.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
      expect((await authenticate("token", cfg)).ok).toBe(true);
    }),
  );

  it.each([false, true])(
    "rejects alias retirement during policy authorization (restored: %s)",
    inState(async (restore: boolean) => {
      const { cfg, email, person, access } = await registerPersonAccessFixture();
      await linkCanonicalUserProfileEmail("retained@example.test", person.id);
      const replacement = await ensureCanonicalUserProfileForEmail("replacement@example.test");
      access.grant = new AbortController();
      access.onAuthorize = () => {
        linkEmail(email, replacement.id);
        if (restore) {
          linkEmail(email, person.id);
        }
      };
      expect(await authenticate("trusted-proxy", cfg, email)).toMatchObject(accessDenied);
      expect(getUserProfileListItem(person.id).id).toBe(person.id);
      expect(access.grant.signal.aborted).toBe(false);
    }),
  );

  it.each(["grant", "alias"])(
    "collects HTTP captures while a retained signal observes %s retirement",
    inState(async (source: string) => {
      const { cfg, email, person, access } = await registerPersonAccessFixture();
      setRuntimeConfigSnapshot(cfg);
      await linkCanonicalUserProfileEmail("retained@example.test", person.id);
      const replacement = await ensureCanonicalUserProfileForEmail("replacement@example.test");
      access.grant = new AbortController();
      const retired = await completeResponseCapture(email);
      const signal = await authenticate("trusted-proxy", cfg, email).then((admitted) => {
        assert(admitted.ok && admitted.requestAuth.operatorAccessAuthority);
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
        await linkCanonicalUserProfileEmail(email, replacement.id);
        await linkCanonicalUserProfileEmail(email, person.id);
      }
      expect(signal.aborted).toBe(true);
    }),
  );

  it(
    "binds revocation to an active response and releases completed keep-alive responses",
    inState(async () => {
      const { cfg, email, person, access } = await registerPersonAccessFixture();
      setRuntimeConfigSnapshot(cfg);
      await linkCanonicalUserProfileEmail("retained@example.test", person.id);
      const replacement = await ensureCanonicalUserProfileForEmail("replacement@example.test");
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
        const captured = await captureGatewayOperatorRunAuthority({
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
        assert(captured?.authority.retain, "Expected retained operator source");
        releaseChild = captured.authority.retain();
        captured.release();
        const disconnected = once(next.res, "close");
        next.res.destroy();
        await disconnected;
        expect(nextAuthority.signal.aborted).toBe(false);
        expect(captured.authority.signal?.aborted).toBe(false);
        setDisplayName(person.id, "Updated during retained work");
        await linkCanonicalUserProfileEmail("added@example.test", person.id);
        expect(aliasStreaming.res.destroyed).toBe(false);
        expect(captured.authority.signal?.aborted).toBe(false);

        await linkCanonicalUserProfileEmail(email, replacement.id);
        await linkCanonicalUserProfileEmail(email, person.id);
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
    }),
  );

  it(
    "shares the durable owner across auth methods and preserves an edited name",
    inState(async () => {
      let profileId: string | undefined;
      for (const method of ["token", "password", "device-token", "none"] as const) {
        const result = await authenticate(method);
        assert(result.ok, "Expected authenticated request");
        expect(result.requestAuth.user).toBeUndefined();
        if (method === "token" || method === "password") {
          expect(result.requestAuth).toMatchObject({
            authMethod: method,
            trustDeclaredOperatorScopes: false,
            operatorRoleActor: { kind: "system" },
          });
        }
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
    }),
  );

  it.each([
    ["token", true, false, undefined],
    ["password", true, false, undefined],
    ["none", true, false, undefined],
    ["device-token", true, false, undefined],
    ["trusted-proxy", true, false, "alice@example.test"],
    ["token", false, true, undefined],
    ["token", true, true, undefined],
  ] as const)(
    "resolves %s HTTP identity (roles=%s, storage failure=%s, user=%s)",
    async (method, configured, storageFailure, user) => {
      await withOpenClawTestState({ label: "http-profile-admission" }, async () => {
        if (storageFailure) {
          ensureOwner.mockImplementationOnce(() => {
            throw new Error("profile storage unavailable");
          });
        }
        const result = await authenticate(method, configured ? { gateway: { roles } } : {}, user);
        if (method === "none" || method === "device-token") {
          expect(result).toEqual({
            ok: false,
            authResult: { ok: false, reason: "user_profile_unavailable" },
          });
          expect(ensureOwner).not.toHaveBeenCalled();
          return;
        }
        assert(result.ok, "Expected authenticated request");
        if (user) {
          expect(result.requestAuth.user).toBe(user);
          expect(result.requestAuth.authenticatedUserProfile?.displayName).toBe("alice");
          expect(result.requestAuth.operatorRolePolicy?.scopes).toEqual(["operator.read"]);
          expect(ensureOwner).not.toHaveBeenCalled();
        } else {
          expect(result.requestAuth.operatorRolePolicy).toBeUndefined();
          if (storageFailure) {
            expect(result).toMatchObject({ ok: true, requestAuth: { authMethod: "token" } });
            expect(result.requestAuth.authenticatedUserProfile).toBeUndefined();
          } else {
            expect(result.requestAuth.authenticatedUserProfile).toBeDefined();
            expect(result.requestAuth.trustDeclaredOperatorScopes).toBe(false);
            expect(resolveSharedSecretHttpOperatorScopes(req, result.requestAuth)).toContain(
              "operator.admin",
            );
          }
        }
      });
    },
  );
});

describe("Control UI session owner reads", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
  });

  const rolesWithIsolation = {
    ...roles,
    definitions: {
      ...roles.definitions,
      isolated: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
      admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
    },
  } satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
  const sessionBy = (profileId: string, visibility: "shared" | "draft" = "shared") => ({
    createdActor: { type: "human" as const, source: "profile" as const, id: profileId },
    visibility,
  });

  async function authorizeSessionRead(cfg: OpenClawConfig, email: string) {
    setRuntimeConfigSnapshot(cfg);
    authorize.mockResolvedValueOnce({ ok: true, method: "trusted-proxy", user: email });
    const response = makeMockHttpResponse();
    const result = await authorizeControlUiSessionOwnerReadRequestOrReply({
      req,
      res: response.res,
      auth: noAuth,
      cfg,
      getRuntimeConfig: () => cfg,
    });
    return { result, response };
  }

  it(
    "lets a profile read its own sessions and shared sessions within its role cap",
    inState(async () => {
      const cfg: OpenClawConfig = { gateway: { roles: rolesWithIsolation } };
      const creator = await ensureCanonicalUserProfileForEmail("creator@example.test");
      const other = await ensureCanonicalUserProfileForEmail("other@example.test");

      const viewer = await authorizeSessionRead(cfg, "creator@example.test");
      assert(viewer.result, "Expected the creating profile to be admitted");
      expect(viewer.response.end).not.toHaveBeenCalled();
      expect(viewer.result.canReadSession("agent:main:own", sessionBy(creator.id, "draft"))).toBe(
        true,
      );
      expect(viewer.result.canReadSession("agent:main:shared", sessionBy(other.id))).toBe(true);
      expect(viewer.result.canReadSession("agent:main:draft", sessionBy(other.id, "draft"))).toBe(
        false,
      );
      expect(
        viewer.result.canReadSession("agent:main:incognito", {
          ...sessionBy(other.id),
          incognito: true,
        }),
      ).toBe(false);

      await setCanonicalUserProfileRole(creator.id, "isolated");
      invalidateOperatorRolePolicy(creator.id);
      const isolated = await authorizeSessionRead(cfg, "creator@example.test");
      assert(isolated.result, "Expected the isolated profile to be admitted");
      expect(isolated.result.canReadSession("agent:main:own", sessionBy(creator.id))).toBe(true);
      expect(isolated.result.canReadSession("agent:main:shared", sessionBy(other.id))).toBe(false);
    }),
  );

  it(
    "keeps the unfiltered view for admin scope",
    inState(async () => {
      const cfg: OpenClawConfig = { gateway: { roles: rolesWithIsolation } };
      const other = await ensureCanonicalUserProfileForEmail("other@example.test");
      const operator = await ensureCanonicalUserProfileForEmail("admin@example.test");
      await setCanonicalUserProfileRole(operator.id, "admin");
      invalidateOperatorRolePolicy(operator.id);
      const admin = await authorizeSessionRead(cfg, "admin@example.test");
      assert(admin.result, "Expected the admin-role profile to be admitted");
      expect(admin.result.operatorScopes).toContain("operator.admin");
      expect(admin.result.canReadSession("agent:main:draft", sessionBy(other.id, "draft"))).toBe(
        true,
      );
    }),
  );
});
