import { expect, it, vi } from "vitest";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
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
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const bootstrapCommand = "/bootstrap-fixture";
const credentialReply = "credential mutation accepted";
const tokenCount = (stateDir: string) =>
  Object.keys(loadDeviceBootstrapTokenRecords(stateDir)).length;
const commandPhase = (
  entered: { promise: Promise<void> },
  pending: ReturnType<typeof handlePluginCommand>,
) => Promise.race([entered.promise.then(() => "entered"), pending.then(() => "finished")]);

it.each(
  (["issue", "clear"] as const).flatMap((operation) =>
    (["none", "demote", "reassign"] as const).map((change) => ({ operation, change })),
  ),
)(
  "keeps the admitted plugin owner through $operation bootstrap persistence: $change",
  ({ operation, change }) =>
    withAdminIngress(async ({ cfg, admins, context, state }) => {
      const registry = createEmptyPluginRegistry();
      const admin = admins[0]!;
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let retainedAssertion: (() => void) | undefined;
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "bootstrap-fixture",
        description: "Exercise a scoped plugin command's real credential mutation",
        requiredScopes: ["operator.pairing"],
        handler: async (ctx) => {
          retainedAssertion = ctx.assertOwnerCurrent;
          entered.resolve();
          await resume.promise;
          const options = { baseDir: state.stateDir, assertCurrent: ctx.assertOwnerCurrent };
          const pending =
            operation === "issue"
              ? issueDeviceBootstrapToken({
                  ...options,
                  profile: {
                    roles: ["operator"],
                    scopes: ["operator.admin"],
                    purpose: "mobile-full",
                  },
                })
              : clearDeviceBootstrapTokens(options);
          // The credential owner must revalidate after its lock/state awaits.
          if (change === "demote") {
            setUserProfileRole(admin.profile.id, "member");
          } else if (change === "reassign") {
            unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
          }
          await pending;
          return { text: credentialReply };
        },
      });
      registerPluginCommandInRegistry(registry, "bootstrap-fixture", {
        name: "owner-independent-read",
        description: "An ordinary authorized plugin read",
        handler: () => ({ text: "ordinary read accepted" }),
      });

      await withPluginRuntimeRegistryScope(registry, async () => {
        if (operation === "clear") {
          await issueDeviceBootstrapToken({ baseDir: state.stateDir });
        }
        const before = tokenCount(state.stateDir);
        const params = buildCommandTestParams(
          bootstrapCommand,
          cfg,
          await context(admin.identity.senderId),
          { workspaceDir: state.workspaceDir },
        );
        const originalAssertion = params.command.assertOwnerCurrent;
        const pending = handlePluginCommand(params, true);
        try {
          expect(await commandPhase(entered, pending)).toBe("entered");
          // Replacing the snapshot cannot replace its already-captured capability.
          params.command.assertOwnerCurrent = () => {};
          resume.resolve();
          const outcome = await pending;
          const after = tokenCount(state.stateDir);
          if (change === "none") {
            expect(outcome?.reply?.text).toBe(credentialReply);
            expect(after).toBe(operation === "issue" ? 1 : 0);
          } else {
            expect(after).toBe(before);
            expect(outcome?.reply?.text).toContain("Command failed");
          }
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
      });
    }),
);

it.each([
  { scenario: "missing-policy", admitted: false, allowed: false, consulted: false },
  { scenario: "disabled-policy", admitted: false, allowed: false, consulted: false },
  { scenario: "missing-grant", admitted: false, allowed: false, consulted: true },
  { scenario: "expired-grant", admitted: false, allowed: false, consulted: true },
  { scenario: "allowed", admitted: true, allowed: true, consulted: true },
  { scenario: "restored", admitted: true, allowed: false, consulted: true },
  { scenario: "changed-binding", admitted: true, allowed: false, consulted: true },
  { scenario: "configured-owner", admitted: true, allowed: true, consulted: false },
] as const)(
  "enforces original person access through plugin command effects: $scenario",
  ({ scenario, admitted, allowed, consulted }) =>
    withAdminIngress(async ({ cfg, admins, context, state }) => {
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
          return { text: credentialReply };
        },
      });
      setActivePluginRegistry(registry);
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          const makeParams = async () =>
            buildCommandTestParams(bootstrapCommand, cfg, await context(admin.identity.senderId), {
              workspaceDir: state.workspaceDir,
            });
          const params = await makeParams();
          const pending = handlePluginCommand(params, true);
          try {
            const phase = await commandPhase(entered, pending);
            if (scenario === "restored") {
              grant.abort();
              grant = new AbortController();
            }
            if (scenario === "changed-binding") {
              cfg.gateway!.roles!.definitions.admin!.accessPolicyPlugin = "replacement-policy";
            }
            resume.resolve();
            const outcome = await pending;
            expect(tokenCount(state.stateDir)).toBe(allowed ? 1 : 0);
            expect(phase).toBe(admitted ? "entered" : "finished");
            if (allowed) {
              expect(outcome?.reply?.text).toBe(credentialReply);
            }
            if (scenario === "restored") {
              expect(params.command.assertOwnerCurrent).toThrow();
              expect((await handlePluginCommand(await makeParams(), true))?.reply?.text).toBe(
                credentialReply,
              );
              expect(tokenCount(state.stateDir)).toBe(1);
              expect(params.command.assertOwnerCurrent).toThrow();
            }
            if (!consulted) {
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
          } finally {
            resume.resolve();
            await pending;
          }
        });
      } finally {
        await clearActivePluginRegistry(registry);
      }
    }),
);
