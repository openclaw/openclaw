import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  invalidateOperatorRolePolicy,
  publishOperatorRoleConfigChange,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

it("preserves the live operator source through principal capture without trusting copied labels", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("principal-source@example.test");
    const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.read"] });
    const principal = expectDefined(captureAgentTurnPrincipal(client), "captured principal");
    const context = createContext();
    const source = new AbortController();
    const sourceAuthority = {
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
    };
    const captures = await Promise.all(
      [principal, client, { ...client }].map(async (input) =>
        expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: input,
            context,
            sourceAuthority,
          }),
          "operator source",
        ),
      ),
    );
    try {
      const principalSource = expectDefined(captures[0], "principal authority").authority.source;
      const originalSource = expectDefined(captures[1], "socket authority").authority.source;
      const copiedSource = expectDefined(captures[2], "copied authority").authority.source;
      expect(originalSource).toBeDefined();
      expect(principalSource).toBe(originalSource);
      expect(copiedSource).not.toBe(originalSource);
      for (const capture of captures) {
        expect(capture.authority.assertCurrent).not.toThrow();
      }
      source.abort(new Error("source revoked"));
      for (const capture of captures) {
        expect(capture.authority.assertCurrent).toThrow();
      }
    } finally {
      for (const capture of captures) {
        capture.release();
      }
    }
  });
});

it.each(["capture", "operator tool"])(
  "prepares %s profile authority without parent data SQL",
  async (entry) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("operator-sql@example.test");
      setUserProfileRole(profile.id, "reader");
      const sourceScopes: GatewayOperatorRoleDefinition["scopes"] =
        entry === "operator tool" ? ["operator.read", "operator.write"] : ["operator.read"];
      const client = createOperatorClient({ profileId: profile.id, scopes: sourceScopes });
      const context = createContext();
      let cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/a" } },
        gateway: {
          roles: {
            definitions: {
              reader: {
                sessions: { others: "none" as const },
                agents: [],
                scopes: sourceScopes,
                modelPolicy: { allow: ["fixture/a", "fixture/b"] },
              },
            },
          },
        },
      };
      context.getRuntimeConfig = () => cfg;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "profileProof.current",
            scope: "operator.read",
            profileAccess: "independent",
            owner: { kind: "core", area: "profile-proof" },
            handler: ({ client: dispatchedClient, respond }: GatewayRequestHandlerOptions) => {
              const authority = expectDefined(
                dispatchedClient?.internal?.operatorRunAuthority,
                "dispatched operator authority",
              );
              authority.assertCurrent();
              respond(true, { profileId: authority.profileId });
            },
          },
        ]);
      const sql = observeHostDataSql();
      try {
        const calibration = new DatabaseSync(":memory:");
        try {
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
        } finally {
          calibration.close();
        }

        if (entry === "capture") {
          const retained = expectDefined(
            await captureGatewayOperatorRunAuthority({ client, context }),
            "operator authority",
          );
          try {
            retained.authority.assertCurrent();
            expect(
              retained.authority.modelPolicy?.allows({ provider: "fixture", model: "a" }),
            ).toBe(true);
            cfg = {
              ...cfg,
              agents: { defaults: { model: { primary: "fixture/b", fallbacks: ["fixture/a"] } } },
            };
            publishOperatorRoleConfigChange(context);
            expect(retained.authority.modelPolicy?.models).toEqual([
              { provider: "fixture", model: "b" },
              { provider: "fixture", model: "a" },
            ]);
            const roles = expectDefined(cfg.gateway?.roles, "configured roles");
            cfg = {
              ...cfg,
              gateway: {
                ...cfg.gateway,
                roles: {
                  ...roles,
                  definitions: {
                    ...roles.definitions,
                    reader: {
                      ...expectDefined(roles.definitions.reader, "reader role"),
                      modelPolicy: { allow: ["fixture/b", "fixture/c"] },
                    },
                  },
                },
              },
            };
            publishOperatorRoleConfigChange(context);
            expect(retained.authority.signal?.aborted).toBe(false);
            expect(
              retained.authority.modelPolicy?.allows({ provider: "fixture", model: "a" }),
            ).toBe(false);
            expect(
              retained.authority.modelPolicy?.allows({ provider: "fixture", model: "b" }),
            ).toBe(true);
            expect(
              retained.authority.modelPolicy?.allows({ provider: "fixture", model: "c" }),
            ).toBe(false);
            const release = expectDefined(retained.authority.retain, "operator retention")();
            retained.release();
            retained.authority.assertCurrent();
            release();
            expect(retained.authority.assertCurrent).toThrow("no longer active");
          } finally {
            retained.release();
          }
        } else {
          await withPluginRuntimeGatewayRequestScope(
            { client, context, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority({ scopes: ["operator.read"] }, async () => {
                const authority = expectDefined(
                  getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
                  "operator tool authority",
                );
                authority.assertCurrent();
                expect(authority.profileId).toBe(profile.id);
                await withOperatorToolGatewayAuthority(
                  { scopes: ["operator.read"], operatorRunAuthority: authority },
                  async () => {
                    const narrowed = expectDefined(
                      getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
                      "narrowed operator authority",
                    );
                    expect(narrowed.scopes).toEqual(["operator.read"]);
                    await expect(
                      dispatchGatewayMethodInProcess(
                        "profileProof.current",
                        {},
                        { disableSyntheticClient: true, requireScopedClient: true },
                      ),
                    ).resolves.toEqual({ profileId: profile.id });
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
    });
  },
);

it.each([
  "client",
  "gateway",
  "source",
  "invocation",
  "profile",
  "role",
  "role restored",
  "policy restored",
  "unrelated policy",
  "target alias",
  "model policy widened",
  "model policy narrowed",
  "model policy restored",
] as const)(
  "keeps current authority through %s while operator source preparation is pending",
  async (revocation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("preparing-operator@example.test");
      const target = ensureProfileForEmail("preparing-target@example.test");
      setUserProfileRole(profile.id, "reader");
      const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.read"] });
      const context = createContext();
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "fixture/a" } },
        gateway: {
          roles: {
            definitions: {
              reader: {
                agents: [],
                scopes: ["operator.read"],
                sessions: { others: "none" },
                modelPolicy: { allow: ["fixture/a", "fixture/b"] },
              },
              denied: { agents: [], scopes: [], sessions: { others: "none" } },
            },
          },
        },
      };
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
        sourceAuthority: {
          signal: source.signal,
          assertCurrent: () => source.signal.throwIfAborted(),
        },
        invocationAuthority: {
          signal: invocation.signal,
          assertCurrent: () => invocation.signal.throwIfAborted(),
        },
      }).then((captured) => {
        try {
          if (revocation.startsWith("model policy")) {
            const authority = expectDefined(captured, "prepared model authority").authority;
            expect(authority.signal?.aborted).toBe(false);
            authority.assertCurrent();
            expect(authority.modelPolicy?.allows({ provider: "fixture", model: "a" })).toBe(
              revocation !== "model policy narrowed",
            );
            expect(authority.modelPolicy?.allows({ provider: "fixture", model: "b" })).toBe(true);
            expect(authority.modelPolicy?.allows({ provider: "fixture", model: "c" })).toBe(false);
          }
          sideEffect();
        } finally {
          captured?.release();
        }
      });
      const allowed =
        revocation === "unrelated policy" ||
        revocation === "target alias" ||
        revocation.startsWith("model policy");
      const checked = allowed
        ? expect(pending).resolves.toBeUndefined()
        : expect(pending).rejects.toThrow();
      try {
        await entered.promise;
        if (revocation === "client") {
          connected = false;
        } else if (revocation === "gateway") {
          currentGateway = createContext();
        } else if (revocation === "source") {
          source.abort(new Error("source ended"));
        } else if (revocation === "invocation") {
          invocation.abort(new Error("invocation ended"));
        } else if (revocation === "profile") {
          linkEmail("preparing-operator@example.test", target.id);
        } else if (revocation === "role") {
          setUserProfileRole(profile.id, "denied");
        } else if (revocation === "role restored") {
          for (const role of ["denied", "reader"]) {
            await setCanonicalUserProfileRole(profile.id, role, {
              onCommitted: invalidateOperatorRolePolicy,
            });
          }
        } else if (revocation === "target alias") {
          linkEmail("preparing-target@example.test", profile.id);
        } else if (revocation.startsWith("model policy")) {
          currentConfig = structuredClone(cfg);
          const role = expectDefined(
            currentConfig.gateway?.roles?.definitions.reader,
            "reader role",
          );
          role.modelPolicy = {
            allow:
              revocation === "model policy widened"
                ? ["fixture/a", "fixture/b", "fixture/c"]
                : ["fixture/b", "fixture/c"],
          };
          publishOperatorRoleConfigChange(context);
          if (revocation === "model policy restored") {
            currentConfig = cfg;
            publishOperatorRoleConfigChange(context);
          }
        } else {
          currentConfig = structuredClone(cfg);
          const roles = expectDefined(currentConfig.gateway?.roles, "configured roles");
          roles.definitions[revocation === "policy restored" ? "reader" : "denied"] = {
            agents: [],
            scopes: [],
            sessions: { others: "none" },
            sandbox: "required",
          };
          publishOperatorRoleConfigChange(context);
          if (revocation === "policy restored") {
            currentConfig = cfg;
            publishOperatorRoleConfigChange(context);
          }
        }
        resume.resolve();
        await checked;
        expect(sideEffect).toHaveBeenCalledTimes(allowed ? 1 : 0);
      } finally {
        resume.resolve();
        await pending.catch(() => {});
        spy.mockRestore();
      }
    });
  },
);

it("keeps target and unrelated sources live across alias additions, but rejects source merges", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
  });
});

it("rechecks current role and latched revocation after a source callback mutates and restores it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("callback-operator@example.test");
    const context = createContext();
    const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.read"] });
    let change = false;
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({
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
      }),
      "callback authority",
    );
    try {
      change = true;
      expect(captured.authority.assertCurrent).toThrow("no longer active");
      expect(captured.authority.signal?.aborted).toBe(true);
      expect(captured.authority.assertCurrent).toThrow("no longer active");
    } finally {
      captured.release();
    }
  });
});
