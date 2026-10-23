import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  invalidateOperatorRolePolicy,
  publishOperatorRoleConfigChange,
  resolveOperatorRolePolicy,
} from "./operator-role-policy.js";
import {
  captureChannelOperatorRunAuthority,
  captureGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
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
async function capture(options: Parameters<typeof captureGatewayOperatorRunAuthority>[0]) {
  return expectDefined(await captureGatewayOperatorRunAuthority(options), "operator authority");
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
    gateway: { roles: { definitions: { reader, ...(withDenied ? { denied } : {}) } } },
  } satisfies OpenClawConfig;
}
function registerProof(
  context: OperatorFixture["context"],
  name: string,
  scope: "operator.read" | "operator.write",
  handler: (options: GatewayRequestHandlerOptions) => void,
) {
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name,
        scope,
        profileAccess: "independent",
        owner: { kind: "core", area: "proof" },
        handler,
      },
    ]);
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
      captureGatewayOperatorRunAuthority({
        client,
        context: { getRuntimeConfig: () => ({}) },
      }),
    ).resolves.toBeUndefined();
  },
);

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

it("preserves the live operator source through principal capture without trusting copied labels", () =>
  withOperator(async ({ profile, client, context }) => {
    const principal = expectDefined(captureAgentTurnPrincipal(client), "captured principal");
    const source = new AbortController();
    const sourceAuthority = abortAuthority(source);
    const captures = await Promise.all(
      [principal, client, { ...client }].map((input) =>
        capture({ client: input, context, sourceAuthority }),
      ),
    );
    try {
      const principalSource = expectDefined(captures[0], "principal authority").authority.source;
      const originalSource = expectDefined(captures[1], "socket authority").authority.source;
      const copiedSource = expectDefined(captures[2], "copied authority").authority.source;
      expect(originalSource).toBeDefined();
      expect(principalSource).toBe(originalSource);
      expect(copiedSource).not.toBe(originalSource);
      const channel = captureChannelOperatorRunAuthority({
        profileId: profile.id,
        assignedRole: null,
        scopes: ["operator.read"],
        gatewayAccessGrant: null,
        getRuntimeConfig: context.getRuntimeConfig,
        ...sourceAuthority,
      });
      const readers = [...captures.map(({ authority }) => authority), channel].map((authority) =>
        expectDefined(authority.readCurrentRoleFacts, "role reader"),
      );
      for (const read of readers) {
        const facts = read();
        expect(facts.assignedRole).toBeNull();
        expect(facts.githubLogin ?? null).toBeNull();
        Object.assign(facts, { assignedRole: "owner", githubLogin: "changed" });
        expect(read()).toMatchObject({ assignedRole: null, githubLogin: null });
      }
      for (const retained of captures) {
        expect(retained.authority.assertCurrent).not.toThrow();
      }
      source.abort(new Error("source revoked"));
      for (const read of readers) {
        expect(read).toThrow();
      }
      for (const retained of captures) {
        expect(retained.authority.assertCurrent).toThrow();
      }
    } finally {
      for (const retained of captures) {
        retained.release();
      }
    }
  }));

it("checks a live access source once for each role-policy evaluation", () =>
  withOperator(async ({ profile, client, context }) => {
    setUserProfileRole(profile.id, "reader");
    const config = readerConfig(["operator.read"]);
    context.getRuntimeConfig = () => config;
    let permitted = true;
    const assertAccess = vi.fn(() => {
      if (!permitted) {
        throw new Error("access grant ended");
      }
    });
    const captured = await capture({
      client,
      context,
      sourceAuthority: { assertCurrent: assertAccess },
    });
    using _ = { [Symbol.dispose]: captured.release };
    client.internal = { ...client.internal, operatorRunAuthority: captured.authority };
    assertAccess.mockClear();

    expect(resolveOperatorRolePolicy(client, config)).toBe(config.gateway.roles.definitions.reader);
    expect(assertAccess).toHaveBeenCalledOnce();
    permitted = false;
    expect(() => resolveOperatorRolePolicy(client, config)).toThrow("access grant ended");
    expect(assertAccess).toHaveBeenCalledTimes(2);
    permitted = true;
    expect(() => resolveOperatorRolePolicy(client, config)).toThrow("access grant ended");
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
        {
          using calibration = new DatabaseSync(":memory:");
          calibration.exec("CREATE TABLE calibration (value INTEGER)");
          calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
          const read = calibration.prepare("SELECT value FROM calibration");
          read.get();
          read.all();
          expect([...read.iterate()]).toHaveLength(1);
          for (const call of sql.calls) {
            expect(call).toHaveBeenCalled();
            call.mockClear();
          }
        }

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
          expect(authority.modelPolicy?.models).toEqual([modelRef("b"), modelRef("a")]);
          cfg = structuredClone(cfg);
          expectDefined(cfg.gateway?.roles?.definitions.reader, "reader role").modelPolicy = {
            allow: ["fixture/b", "fixture/c"],
          };
          publishOperatorRoleConfigChange(context);
          expect(authority.signal?.aborted).toBe(false);
          expectModels(authority, [false, true, false]);
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
        for (const call of sql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
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
      const pending = captureGatewayOperatorRunAuthority({
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
        ["policy restored", "unrelated policy", "target alias"].includes(revocation) ||
        revocation.startsWith("model policy");
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

it("keeps target and unrelated sources live across alias additions, but rejects source merges", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const source = ensureProfileForEmail("alias-source@example.test");
    const target = ensureProfileForEmail("alias-target@example.test");
    const other = ensureProfileForEmail("alias-other@example.test");
    const context = createContext();
    const captures = await Promise.all(
      [source, target, other].map((profile) =>
        captureGatewayOperatorRunAuthority({
          client: createOperatorClient({ profileId: profile.id, scopes: ["operator.read"] }),
          context,
        }),
      ),
    );
    try {
      linkEmail("alias-source@example.test", target.id);
      expect(captures[0]?.authority.assertCurrent).toThrow();
      expect(captures[1]?.authority.assertCurrent).not.toThrow();
      expect(captures[2]?.authority.assertCurrent).not.toThrow();
    } finally {
      captures.forEach((captured) => captured?.release());
    }
  }));

it("rechecks current role and latched revocation after a source callback mutates and restores it", () =>
  withOperator(async ({ profile, client, context }) => {
    let change = false;
    const captured = await capture({
      client,
      context,
      sourceAuthority: {
        assertCurrent: () => {
          if (change) {
            change = false;
            setUserProfileRole(profile.id, "temporary");
            setUserProfileRole(profile.id, null);
          }
        },
      },
    });
    using _ = { [Symbol.dispose]: captured.release };

    change = true;
    expect(captured.authority.assertCurrent).toThrow("no longer active");
    expect(captured.authority.signal?.aborted).toBe(true);
    expect(captured.authority.assertCurrent).toThrow("no longer active");
  }));
