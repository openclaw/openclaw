import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import { classifySqliteMutation } from "../infra/sqlite-schema-mutation.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureSkillLibrarySchema } from "../skills/library/store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
import * as profileReader from "../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.test-support.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import {
  invalidateOperatorRolePolicy,
  publishOperatorRoleConfigChange,
  resolveOperatorRolePolicy,
} from "./operator-role-policy.js";
import {
  captureChannelOperatorRunAuthority,
  prepareGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import {
  registerIngressPrincipalRecovery,
  restoreIngressPrincipalRecovery,
} from "./remote-ingress-principal-recovery.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

function modelRef(model: string) {
  return { provider: "fixture", model };
}

function expectModels(
  authority: Awaited<ReturnType<typeof capture>>["authority"],
  expected: boolean[],
) {
  expect(["a", "b", "c"].map((model) => authority.modelPolicy?.allows(modelRef(model)))).toEqual(
    expected,
  );
}
async function capture(options: Parameters<typeof prepareGatewayOperatorRunAuthority>[0]) {
  return expectDefined(await prepareGatewayOperatorRunAuthority(options), "operator authority");
}
function abortAuthority(controller: AbortController) {
  return { signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted() };
}

type OperatorFixture = ReturnType<typeof operatorFixture>;
function operatorFixture(scopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.read"]) {
  const profile = ensureProfileForEmail("operator@example.test");
  return {
    profile,
    client: createOperatorClient({ profileId: profile.id, scopes }),
    context: createContext(),
  };
}
function withOperator(
  run: (fixture: OperatorFixture) => Promise<void>,
  scopes?: GatewayOperatorRoleDefinition["scopes"],
) {
  return withOpenClawTestState({ scenario: "minimal" }, () => run(operatorFixture(scopes)));
}
function readerConfig(scopes: GatewayOperatorRoleDefinition["scopes"], withDenied = false) {
  const reader: GatewayOperatorRoleDefinition = {
    sessions: { others: "none" },
    agents: [],
    scopes,
    modelPolicy: { allow: ["fixture/a", "fixture/b"] },
  };
  const denied: GatewayOperatorRoleDefinition = {
    agents: [],
    scopes: [],
    sessions: { others: "none" },
  };
  return {
    agents: { defaults: { model: "fixture/a" } },
    gateway: {
      roles: { default: "reader", definitions: { reader, ...(withDenied ? { denied } : {}) } },
    },
  } satisfies OpenClawConfig;
}
function registerProof(
  context: OperatorFixture["context"],
  name: string,
  scope: "operator.read" | "operator.write",
  handler: (options: GatewayRequestHandlerOptions) => void,
) {
  context.getGatewayMethodRegistry = createContext([
    [name, scope, "proof", handler],
  ]).getGatewayMethodRegistry;
}
function scoped<T>({ client, context }: OperatorFixture, run: () => T) {
  return withPluginRuntimeGatewayRequestScope(
    { client, context, isWebchatConnect: () => false },
    run,
  );
}
function dispatch(name: string) {
  return dispatchGatewayMethodInProcess(
    name,
    {},
    { disableSyntheticClient: true, requireScopedClient: true },
  );
}
function toolAuthority() {
  return expectDefined(
    getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
    "operator tool authority",
  );
}

it.each(["unprofiled backend", "synthetic owner"] as const)(
  "does not mint durable operator authority for an authenticated %s",
  async (source) => {
    const client = createOperatorClient({
      profileId: GATEWAY_OWNER_PROFILE_ID,
      scopes: ["operator.admin"],
    });
    client.authenticatedUserId = undefined;
    client.internal = {
      authenticatedOperator: true,
      operatorRoleActor: { kind: "system" },
      ...(source === "synthetic owner" ? { syntheticClient: true } : {}),
    };
    if (source === "unprofiled backend") {
      client.authenticatedUserProfile = undefined;
      client.connect.client.id = GATEWAY_CLIENT_IDS.GATEWAY_CLIENT;
      client.connect.client.mode = GATEWAY_CLIENT_MODES.BACKEND;
    }
    await expect(
      prepareGatewayOperatorRunAuthority({
        client,
        context: { getRuntimeConfig: () => ({}) },
      }),
    ).resolves.toBeUndefined();
  },
);

it("keeps admitted work when its ingress owner changes and refuses new admission as unavailable", () =>
  withOperator(async ({ profile, client, context }) => {
    const source = new AbortController();
    const owner = {
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
      resume: async (audienceId: string) => ({
        audienceId,
        recoveryId: "accepted-consent",
        principal: { kind: "person" as const, profileId: profile.id },
        operatorScopeCeiling: ["operator.read"],
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
      }),
    };
    registerIngressPrincipalRecovery(context, "queued-app", owner);
    const restored = await restoreIngressPrincipalRecovery(
      context,
      { pluginId: "queued-app", audienceId: "queued-person", recoveryId: "accepted-consent" },
      profile.id,
      ["operator.read"],
    );
    const captured = await capture({ client, context, sourceAuthority: restored });
    try {
      expect(captured.authority.assertCurrent).not.toThrow();
      registerIngressPrincipalRecovery(context, "queued-app", { ...owner });
      const next = capture({ client, context, sourceAuthority: restored });
      await expect(next).rejects.toBeInstanceOf(GatewayDispatchUnavailableError);
      await expect(next).rejects.toMatchObject({
        retryable: true,
        message: expect.stringContaining("owner changed"),
      });
      expect(restored.signal.aborted).toBe(false);
      expect(captured.authority.signal?.aborted).toBe(false);
      expect(captured.authority.assertCurrent).not.toThrow();
      source.abort(new Error("ingress grant retired"));
      expect(captured.authority.signal?.aborted).toBe(false);
      expect(captured.authority.assertCurrent).not.toThrow();
    } finally {
      captured.release();
      restored.release();
      source.abort();
    }
  }));

it("prepares a warm skill library without DDL after the tool caller's initiating request closes", () =>
  withOperator(
    async ({ profile, client, context }) => {
      const database = openOpenClawStateDatabase();
      database.db.exec(getOpenClawStateFeatureSchemaSql("skill_library_entries"));
      const request = await capture({ client, context });
      const releaseTool = expectDefined(request.authority.retain, "tool retention")();
      client.internal = { operatorRunAuthority: request.authority };
      registerProof(context, "libraryProof.prepare", "operator.write", ({ respond }) => {
        ensureSkillLibrarySchema({ database }, () => request.authority.assertCurrent());
        respond(true, { profileId: request.authority.profileId });
      });
      const schemaMutations: string[] = [];
      const observation = observeHostDataSql((sql, db) => {
        if (db === database.db && classifySqliteMutation(sql, "batch").mainSchemaChange) {
          schemaMutations.push(sql);
        }
      });
      try {
        request.release();
        await expect(
          scoped({ profile, client, context }, () => dispatch("libraryProof.prepare")),
        ).resolves.toEqual({ profileId: profile.id });
        request.authority.assertCurrent();
        expect(schemaMutations).toEqual([]);
      } finally {
        observation.restore();
        releaseTool();
        request.release();
      }
    },
    ["operator.write"],
  ));

it("keeps gateway and channel role facts immutable while honoring explicit lifecycle cancellation", () =>
  withOperator(async ({ profile, client, context }) => {
    const principal = expectDefined(captureAgentTurnPrincipal(client), "captured principal");
    const source = new AbortController();
    const sourceAuthority = abortAuthority(source);
    const captured = await capture({
      client: principal,
      context,
      invocationAuthority: sourceAuthority,
    });
    using _ = { [Symbol.dispose]: captured.release };
    const channel = captureChannelOperatorRunAuthority({
      profileId: profile.id,
      canonicalIdentity: null,
      assignedRole: null,
      scopes: ["operator.read"],
      gatewayAccessGrant: null,
      getRuntimeConfig: context.getRuntimeConfig,
      ...sourceAuthority,
    });
    const authorities = [captured.authority, channel];
    const readers = authorities.map((authority) =>
      expectDefined(authority.readCurrentRoleFacts, "role reader"),
    );
    for (const read of readers) {
      const facts = read();
      expect(facts.assignedRole).toBeNull();
      expect(facts.githubLogin ?? null).toBeNull();
      Object.assign(facts, { assignedRole: "owner", githubLogin: "changed" });
      expect(read()).toMatchObject({ assignedRole: null, githubLogin: null });
    }
    for (const authority of authorities) {
      expect(authority.assertCurrent).not.toThrow();
    }
    source.abort(new Error("source revoked"));
    for (const read of readers) {
      expect(read).toThrow();
    }
    for (const authority of authorities) {
      expect(authority.assertCurrent).toThrow();
    }
  }));

it("admits channel role and model policy once while retaining explicit cancellation", () =>
  withOperator(async ({ profile, context }) => {
    const config = readerConfig(["operator.read"]);
    context.getRuntimeConfig = () => config;
    const lifecycle = new AbortController();
    let permitted = true;
    const input = {
      profileId: profile.id,
      canonicalIdentity: null,
      assignedRole: "reader",
      scopes: ["operator.read"],
      gatewayAccessGrant: null,
      getRuntimeConfig: context.getRuntimeConfig,
      assertCurrent: () => {
        if (!permitted) {
          throw new Error("channel requester is no longer admitted");
        }
      },
      signal: lifecycle.signal,
    };
    const admitted = captureChannelOperatorRunAuthority(input);
    Object.assign(config.gateway.roles.definitions.reader, {
      modelPolicy: { allow: ["fixture/b", "fixture/c"] },
      sandbox: "required",
      agents: ["restricted"],
    });
    permitted = false;
    publishOperatorRoleConfigChange(context);
    expect(admitted.assertCurrent).not.toThrow();
    expectModels(admitted, [true, true, false]);
    expect(admitted.rolePolicy).toMatchObject({ sandboxRequired: false, agents: [] });
    expect(admitted.readCurrentRoleFacts?.().policy?.modelPolicy).toEqual({
      allow: ["fixture/a", "fixture/b"],
    });
    expect(() => captureChannelOperatorRunAuthority(input)).toThrow(
      "channel requester is no longer admitted",
    );
    permitted = true;
    const next = captureChannelOperatorRunAuthority(input);
    expectModels(next, [false, true, true]);
    expect(next.rolePolicy).toMatchObject({ sandboxRequired: true, agents: ["restricted"] });
    lifecycle.abort(new Error("channel work cancelled"));
    expect(admitted.assertCurrent).toThrow("channel work cancelled");
    expect(next.assertCurrent).toThrow("channel work cancelled");
  }));

it("keeps admitted role authority after access revocation and refuses the next request", () =>
  withOperator(async ({ profile, client, context }) => {
    setUserProfileRole(profile.id, "reader");
    const config = readerConfig(["operator.read"]);
    context.getRuntimeConfig = () => config;
    const source = new AbortController();
    const sourceAuthority = abortAuthority(source);
    client.internal = { ...client.internal, operatorAccessAuthority: sourceAuthority };
    const captured = await capture({ client, context });
    using _ = { [Symbol.dispose]: captured.release };
    const retained = {
      ...client,
      internal: { ...client.internal, operatorRunAuthority: captured.authority },
    };
    expect(resolveOperatorRolePolicy(retained, config)).toEqual(
      config.gateway.roles.definitions.reader,
    );
    source.abort(new Error("access grant ended"));
    expect(captured.authority.signal?.aborted).toBe(false);
    expect(resolveOperatorRolePolicy(retained, config)).toEqual(
      config.gateway.roles.definitions.reader,
    );
    await expect(capture({ client, context })).rejects.toThrow("access grant ended");
  }));

it("keeps captured role grants when current grants change and refuses a fresh capture", () =>
  withOperator(async ({ profile, client, context }) => {
    setUserProfileRole(profile.id, "reader");
    const config = readerConfig([
      "operator.read",
      "operator.talk",
      "operator.pairing",
      "operator.approvals",
      "operator.questions",
      "operator.sessions.read",
    ]);
    context.getRuntimeConfig = () => config;
    client.connect.scopes = [" operator.read ", " \t"];
    const captured = await capture({ client, context });
    using _ = { [Symbol.dispose]: captured.release };
    const role = config.gateway.roles.definitions.reader;
    const grants = role.scopes;
    expect(captured.authority.assertCurrent).not.toThrow();
    grants[0] = "operator.sessions.read";
    expect(captured.authority.assertCurrent).not.toThrow();
    await expect(capture({ client, context })).rejects.toThrow("Your operator role changed");
  }));

it("keeps an admitted role-free policy when named roles are enabled", () =>
  withOperator(async ({ client, context }) => {
    let config: OpenClawConfig = {};
    context.getRuntimeConfig = () => config;
    const captured = await capture({ client, context });
    using _ = { [Symbol.dispose]: captured.release };
    const retained = { ...client, internal: { operatorRunAuthority: captured.authority } };
    config = readerConfig([]);
    expect(resolveOperatorRolePolicy(retained, config)).toBeUndefined();
    await expect(capture({ client, context })).rejects.toThrow("Your operator role changed");
  }));

it.each(["capture", "operator tool"])(
  "prepares %s profile authority without parent data SQL",
  (entry) =>
    withOperator(async ({ profile, context }) => {
      setUserProfileRole(profile.id, "reader");
      const sourceScopes: GatewayOperatorRoleDefinition["scopes"] =
        entry === "operator tool" ? ["operator.read", "operator.write"] : ["operator.read"];
      const client = createOperatorClient({ profileId: profile.id, scopes: sourceScopes });
      let cfg: OpenClawConfig = readerConfig(sourceScopes);
      context.getRuntimeConfig = () => cfg;
      registerProof(
        context,
        "profileProof.current",
        "operator.read",
        ({ client: dispatchedClient, respond }) => {
          const authority = expectDefined(
            dispatchedClient?.internal?.operatorRunAuthority,
            "dispatched operator authority",
          );
          authority.assertCurrent();
          respond(true, { profileId: authority.profileId });
        },
      );
      const sql = observeHostDataSql();
      try {
        if (entry === "capture") {
          const retained = await capture({ client, context });
          const { authority } = retained;
          using _ = { [Symbol.dispose]: retained.release };

          authority.assertCurrent();
          expect(authority.modelPolicy?.allows(modelRef("a"))).toBe(true);
          cfg = {
            ...cfg,
            agents: { defaults: { model: { primary: "fixture/b", fallbacks: ["fixture/a"] } } },
          };
          publishOperatorRoleConfigChange(context);
          expect(authority.modelPolicy?.models).toEqual([modelRef("a"), modelRef("b")]);
          cfg = structuredClone(cfg);
          expectDefined(cfg.gateway?.roles?.definitions.reader, "reader role").modelPolicy = {
            allow: ["fixture/b", "fixture/c"],
          };
          publishOperatorRoleConfigChange(context);
          expect(authority.signal?.aborted).toBe(false);
          expectModels(authority, [true, true, false]);
          const release = expectDefined(authority.retain, "operator retention")();
          retained.release();
          authority.assertCurrent();
          release();
          expect(authority.assertCurrent).toThrow("no longer active");
        } else {
          await scoped({ profile, client, context }, () =>
            withOperatorToolGatewayAuthority({ scopes: ["operator.read"] }, async () => {
              const authority = toolAuthority();
              authority.assertCurrent();
              expect(authority.profileId).toBe(profile.id);
              await withOperatorToolGatewayAuthority(
                { scopes: ["operator.read"], operatorRunAuthority: authority },
                async () => {
                  const narrowed = toolAuthority();
                  expect(narrowed.scopes).toEqual(["operator.read"]);
                  await expect(dispatch("profileProof.current")).resolves.toEqual({
                    profileId: profile.id,
                  });
                },
              );
            }),
          );
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    }),
);

it.each([
  "client",
  "gateway",
  "source",
  "invocation",
  "profile",
  "role",
  "role restored",
  "policy downgraded",
  "policy restored",
  "unrelated policy",
  "target alias",
  "model policy widened",
  "model policy narrowed",
  "model policy restored",
] as const)(
  "keeps current authority through %s while operator source preparation is pending",
  (revocation) =>
    withOperator(async ({ profile, client, context }) => {
      const target = ensureProfileForEmail("preparing-target@example.test");
      setUserProfileRole(profile.id, "reader");
      const cfg = readerConfig(["operator.read"], true);
      let currentConfig = cfg;
      context.getRuntimeConfig = () => currentConfig;
      let currentGateway = context;
      context.resolveGatewayContext = () => currentGateway;
      let connected = true;
      const source = new AbortController();
      const invocation = new AbortController();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const prepare = profileReader.prepareUserProfileIdentity;
      const spy = vi
        .spyOn(profileReader, "prepareUserProfileIdentity")
        .mockImplementation(async (...args) => {
          const prepared = await prepare(...args);
          entered.resolve();
          await resume.promise;
          return prepared;
        });
      const sideEffect = vi.fn();
      const pending = prepareGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority: () => connected,
        sourceAuthority: abortAuthority(source),
        invocationAuthority: abortAuthority(invocation),
      }).then((captured) => {
        using _ = captured ? { [Symbol.dispose]: captured.release } : undefined;

        if (revocation.startsWith("model policy")) {
          const authority = expectDefined(captured, "prepared model authority").authority;
          expect(authority.signal?.aborted).toBe(false);
          authority.assertCurrent();
          expectModels(authority, [
            revocation !== "model policy narrowed",
            true,
            revocation !== "model policy restored",
          ]);
        }
        sideEffect();
      });
      const allowed =
        ["role restored", "policy restored", "unrelated policy", "target alias"].includes(
          revocation,
        ) || revocation.startsWith("model policy");
      const checked = allowed
        ? expect(pending).resolves.toBeUndefined()
        : expect(pending).rejects.toThrow();
      try {
        await entered.promise;
        const changePolicy = () => {
          currentConfig = structuredClone(cfg);
          const roles = currentConfig.gateway.roles.definitions;
          if (revocation.startsWith("model policy")) {
            roles.reader.modelPolicy = {
              allow:
                revocation === "model policy widened"
                  ? ["fixture/a", "fixture/b", "fixture/c"]
                  : ["fixture/b", "fixture/c"],
            };
          } else {
            roles[revocation === "unrelated policy" ? "denied" : "reader"] = {
              agents: [],
              scopes: [],
              sessions: { others: "none" },
              sandbox: "required",
            };
          }
          publishOperatorRoleConfigChange(context);
          if (revocation.endsWith("restored")) {
            currentConfig = cfg;
            publishOperatorRoleConfigChange(context);
          }
        };
        const mutations = {
          client: () => (connected = false),
          gateway: () => (currentGateway = createContext()),
          source: () => source.abort(new Error("source ended")),
          invocation: () => invocation.abort(new Error("invocation ended")),
          profile: () => linkEmail("operator@example.test", target.id),
          role: () => setUserProfileRole(profile.id, "denied"),
          "target alias": () => linkEmail("preparing-target@example.test", profile.id),
          "role restored": async () => {
            for (const role of ["denied", "reader"]) {
              await setCanonicalUserProfileRole(profile.id, role, {
                onCommitted: invalidateOperatorRolePolicy,
              });
            }
          },
          "policy downgraded": changePolicy,
          "policy restored": changePolicy,
          "unrelated policy": changePolicy,
          "model policy widened": changePolicy,
          "model policy narrowed": changePolicy,
          "model policy restored": changePolicy,
        };
        if (revocation === "role restored") {
          await mutations[revocation]();
        } else {
          mutations[revocation]();
        }
        resume.resolve();
        await checked;
        expect(sideEffect).toHaveBeenCalledTimes(allowed ? 1 : 0);
      } finally {
        resume.resolve();
        await pending.catch(() => {});
        spy.mockRestore();
      }
    }),
);

it("keeps admitted sources across alias additions and source merges", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("alias-source@example.test");
    const target = ensureProfileForEmail("alias-target@example.test");
    const other = ensureProfileForEmail("alias-other@example.test");
    const context = createContext();
    const captures = await Promise.all(
      [source, target, other].map((profile) =>
        prepareGatewayOperatorRunAuthority({
          client: createOperatorClient({ profileId: profile.id, scopes: ["operator.read"] }),
          context,
        }),
      ),
    );
    try {
      linkEmail("alias-source@example.test", target.id);
      expect(captures[0]?.authority.assertCurrent).not.toThrow();
      await expect(
        prepareGatewayOperatorRunAuthority({
          client: createOperatorClient({ profileId: source.id, scopes: ["operator.read"] }),
          context,
        }),
      ).rejects.toThrow();
      expect(captures[1]?.authority.assertCurrent).not.toThrow();
      expect(captures[2]?.authority.assertCurrent).not.toThrow();
    } finally {
      captures.forEach((captured) => captured?.release());
    }
  }));

it("uses the profile grant independently of membership role labels", async () => {
  await withOperator(
    async ({ profile, client, context }) => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      };
      cfg.gateway!.roles!.definitions = {
        ...cfg.gateway!.roles!.definitions,
        ...MEMBER_ROLE_PRESETS,
      };
      setUserProfileRole(profile.id, "operator");
      setRuntimeConfigSnapshot(cfg);
      context.getRuntimeConfig = () => cfg;
      const admitted: OpenClawIdTunnelPrincipal = {
        kind: "member",
        peerKey: "iroh:run-member",
        accountId: "acct_op",
        role: "operator",
      };
      let current = admitted;
      // This is the exact server-attested metadata present on the original connection.
      client.internal = {
        ...client.internal,
        authenticatedOperator: true,
        openclawIdPrincipal: admitted,
      };
      client.authPolicy = captureGatewayAuthPolicy(cfg, {
        role: "operator",
        authMethod: "trusted-proxy",
      });
      setOpenClawIdTunnelPrincipalLookup(() => current);
      try {
        const accepted = await capture({ client, context });
        try {
          accepted.authority.assertCurrent();
          const retained = { ...client, internal: { operatorRunAuthority: accepted.authority } };
          expect(resolveOperatorRolePolicy(retained, cfg)?.scopes).toContain("operator.write");
          current = { ...admitted, role: "viewer" };
          expect(() => accepted.authority.assertCurrent()).not.toThrow();
          expect(resolveOperatorRolePolicy(retained, cfg)?.scopes).toContain("operator.write");
          const fresh = await capture({ client, context });
          fresh.authority.assertCurrent();
          fresh.release();
        } finally {
          accepted.release();
        }
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    },
    ["operator.read", "operator.write"],
  );
});
