import { expect, it, vi } from "vitest";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { GatewayOperatorAccessDeniedError } from "../../gateway/operator-access-policy.js";
import {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { loadDeviceBootstrapTokenRecords } from "../../infra/device-pairing-store.js";
import { registerPluginCommandInRegistry } from "../../plugins/command-registration.js";
import type { PluginGatewayAccessPolicy } from "../../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { isConfiguredCommandOwner } from "../command-auth.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

it.each(["issue", "clear"] as const)(
  "keeps the admitted plugin owner through %s bootstrap persistence",
  async (operation) => {
    await withAdminIngress(async ({ cfg, admins, context, state }) => {
      const registry = createEmptyPluginRegistry();
      const admin = admins[0]!;
      let entered = createDeferredCore();
      let resume = createDeferredCore();
      let revoke: (() => void) | undefined;
      let retainedAssertion: (() => void) | undefined;
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "bootstrap-fixture",
        description: "Exercise a scoped plugin command's real credential mutation",
        requiredScopes: ["operator.pairing"],
        handler: async (ctx) => {
          retainedAssertion = ctx.assertOwnerCurrent;
          entered.resolve();
          await resume.promise;
          const pending =
            operation === "issue"
              ? issueDeviceBootstrapToken({
                  baseDir: state.stateDir,
                  assertCurrent: ctx.assertOwnerCurrent,
                  profile: {
                    roles: ["operator"],
                    scopes: ["operator.admin"],
                    purpose: "mobile-full",
                  },
                })
              : clearDeviceBootstrapTokens({
                  baseDir: state.stateDir,
                  assertCurrent: ctx.assertOwnerCurrent,
                });
          // The credential owner must revalidate after its lock/state awaits.
          revoke?.();
          await pending;
          return { text: "credential mutation accepted" };
        },
      });
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "owner-independent-read",
        description: "An ordinary authorized plugin read",
        handler: () => ({ text: "ordinary read accepted" }),
      });

      await withPluginRuntimeRegistryScope(registry, async () => {
        for (const change of ["none", "demote", "reassign"] as const) {
          entered = createDeferredCore();
          resume = createDeferredCore();
          setUserProfileRole(admin.profile.id, "admin");
          await clearDeviceBootstrapTokens({ baseDir: state.stateDir });
          if (operation === "clear") {
            await issueDeviceBootstrapToken({ baseDir: state.stateDir });
          }
          const before = loadDeviceBootstrapTokenRecords(state.stateDir);
          const params = buildCommandTestParams(
            "/bootstrap-fixture",
            cfg,
            await context(admin.identity.senderId),
            { workspaceDir: state.workspaceDir },
          );
          expect(params.command.senderIsOwner).toBe(true);
          const originalAssertion = params.command.assertOwnerCurrent;
          revoke =
            change === "none"
              ? undefined
              : () => {
                  if (change === "demote") {
                    setUserProfileRole(admin.profile.id, "member");
                  } else {
                    unlinkUserChannelIdentity(admin.profile.id, admin.identity);
                    linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
                  }
                };
          const pending = handlePluginCommand(params, true);
          try {
            expect(
              await Promise.race([
                entered.promise.then(() => "entered"),
                pending.then(() => "finished"),
              ]),
            ).toBe("entered");
            // Replacing the snapshot cannot replace its already-captured capability.
            params.command.assertOwnerCurrent = () => {};
            resume.resolve();
            const outcome = await pending;
            const after = loadDeviceBootstrapTokenRecords(state.stateDir);
            if (change === "none") {
              expect(outcome?.reply?.text).toBe("credential mutation accepted");
              expect(Object.keys(after).length).toBe(operation === "issue" ? 1 : 0);
            } else {
              expect(Object.keys(after).length).toBe(Object.keys(before).length);
              expect(outcome?.reply?.text).toContain("Command failed");
            }
            expect(retainedAssertion).toBeTypeOf("function");
            expect(() => retainedAssertion?.()).toThrow("invocation closed");
            params.command.commandBodyNormalized = "/owner-independent-read";
            params.command.senderIsOwner = false;
            params.command.assertOwnerCurrent = originalAssertion;
            expect((await handlePluginCommand(params, true))?.reply?.text).toBe(
              "ordinary read accepted",
            );
          } finally {
            resume.resolve();
            await pending;
          }
        }
      });
    });
  },
);

it.each([
  "missing-policy",
  "disabled-policy",
  "missing-grant",
  "expired-grant",
  "allowed",
  "revoked",
  "restored",
  "changed-binding",
  "configured-owner",
] as const)(
  "enforces original person access through plugin command effects: %s",
  async (scenario) => {
    await withAdminIngress(async ({ cfg, admins, context, state }) => {
      const admin = admins[0]!;
      const builder = createTestPluginRegistry();
      const registry = builder.registry;
      const record = createPluginRecord({ id: "required-access-fixture" });
      registry.plugins.push(record);
      cfg.gateway!.roles!.definitions.admin!.accessPolicyPlugin = record.id;
      let grant = new AbortController();
      if (scenario === "expired-grant") {
        grant.abort();
      }
      const authorize = vi.fn<PluginGatewayAccessPolicy["authorize"]>(() => {
        if (scenario === "missing-grant") {
          return undefined;
        }
        const admittedGrant = grant;
        return {
          signal: admittedGrant.signal,
          assertCurrent: () => admittedGrant.signal.throwIfAborted(),
        };
      });
      if (scenario !== "missing-policy") {
        builder.createApi(record, { config: cfg }).registerGatewayAccessPolicy({ authorize });
      }
      if (scenario === "disabled-policy" || scenario === "configured-owner") {
        record.enabled = false;
      }
      if (scenario === "configured-owner") {
        cfg.commands!.ownerAllowFrom = [admin.identity.senderId];
      }
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "bootstrap-fixture",
        description: "Issue a credential only while the admitted person's access is current",
        requiredScopes: ["operator.pairing"],
        handler: async (ctx) => {
          entered.resolve();
          await resume.promise;
          await issueDeviceBootstrapToken({
            baseDir: state.stateDir,
            assertCurrent: ctx.assertOwnerCurrent,
          });
          return { text: "credential mutation accepted" };
        },
      });
      setActivePluginRegistry(registry);
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          const deniedAtAdmission = [
            "missing-policy",
            "disabled-policy",
            "missing-grant",
            "expired-grant",
            "configured-owner",
          ].includes(scenario);
          if (scenario === "configured-owner") {
            expect(
              isConfiguredCommandOwner(cfg, {
                channel: admin.identity.channelId,
                accountId: admin.identity.accountId,
                senderId: admin.identity.senderId,
              }),
            ).toBe(true);
          }
          if (deniedAtAdmission) {
            await expect(context(admin.identity.senderId)).rejects.toBeInstanceOf(
              GatewayOperatorAccessDeniedError,
            );
            expect(Object.keys(loadDeviceBootstrapTokenRecords(state.stateDir))).toHaveLength(0);
          } else {
            const params = buildCommandTestParams(
              "/bootstrap-fixture",
              cfg,
              await context(admin.identity.senderId),
              { workspaceDir: state.workspaceDir },
            );
            if (scenario === "allowed") {
              const queries = vi.spyOn(openOpenClawStateDatabase().db, "prepare");
              try {
                expect(params.command.assertOwnerCurrent).not.toThrow();
                expect(queries).not.toHaveBeenCalled();
              } finally {
                queries.mockRestore();
              }
            }
            const pending = handlePluginCommand(params, true);
            try {
              const phase = await Promise.race([
                entered.promise.then(() => "entered"),
                pending.then(() => "finished"),
              ]);
              if (scenario === "revoked" || scenario === "restored") {
                grant.abort();
              }
              if (scenario === "restored") {
                grant = new AbortController();
              }
              if (scenario === "changed-binding") {
                cfg.gateway!.roles!.definitions.admin!.accessPolicyPlugin = "replacement-policy";
              }
              resume.resolve();
              const outcome = await pending;
              const allowed = scenario === "allowed";
              expect(Object.keys(loadDeviceBootstrapTokenRecords(state.stateDir))).toHaveLength(
                allowed ? 1 : 0,
              );
              expect(phase).toBe("entered");
              if (allowed) {
                expect(outcome?.reply?.text).toBe("credential mutation accepted");
              }
              if (scenario === "restored") {
                expect(params.command.assertOwnerCurrent).toThrow();
                const next = buildCommandTestParams(
                  "/bootstrap-fixture",
                  cfg,
                  await context(admin.identity.senderId),
                  { workspaceDir: state.workspaceDir },
                );
                expect((await handlePluginCommand(next, true))?.reply?.text).toBe(
                  "credential mutation accepted",
                );
                expect(Object.keys(loadDeviceBootstrapTokenRecords(state.stateDir))).toHaveLength(
                  1,
                );
                expect(params.command.assertOwnerCurrent).toThrow();
              }
            } finally {
              resume.resolve();
              await pending;
            }
          }
          if (["missing-policy", "disabled-policy", "configured-owner"].includes(scenario)) {
            expect(authorize).not.toHaveBeenCalled();
          } else {
            expect(authorize).toHaveBeenCalledWith({
              config: cfg,
              profile: {
                profileId: admin.profile.id,
                emails: ["ada@example.test"],
                assignedRole: "admin",
              },
              requiredByRole: true,
            });
          }
        });
      } finally {
        await clearActivePluginRegistry(registry);
      }
    });
  },
);
