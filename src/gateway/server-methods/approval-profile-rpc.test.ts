import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createTestOperatorAuthority } from "../../agents/admitted-run-context.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { addSessionMemberInWorker } from "../../config/sessions/session-sharing-store.async.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { listVisiblePendingApprovalRequests } from "./approval-record-lookup.js";
import {
  bindApprovalHandlers,
  cleanupApprovalHandlerFixtures,
  createClient,
  createHandlers,
  createManagers,
  getOperatorApproval,
  registerExec,
  registerPlugin,
  registerSystemAgent,
} from "./approval.handlers.test-support.js";
import {
  createApprovalInvocation,
  createClient as createSocketClient,
  createContext,
} from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import { systemAgentApprovalHandlers } from "./system-agent-approvals.js";
import type { GatewayClient } from "./types.js";

it("restricts invited members to their own approvals across generic lookup, resolution, history and pending families", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "invited",
            definitions: {
              invited: {
                agents: "*",
                scopes: ["operator.read", "operator.write", "operator.approvals"],
                sessions: { others: "invited" },
              },
              admin: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const profiles = Object.fromEntries(
        ["creator", "raiser", "other", "admin"].map((name) => [
          name,
          ensureProfileForEmail(`${name}@approval.test`).id,
        ]),
      );
      setUserProfileRole(profiles.admin!, "admin");
      const catalog = await prepareUserProfileCatalog();
      const peer = (name: string) => {
        const transport = createClient({ deviceId: name })!;
        const client: GatewayClient = {
          ...transport,
          connect: transport.connect!,
          authenticatedUserProfile: {
            profileId: profiles[name]!,
            displayName: null,
            hasAvatar: false,
            updatedAt: 0,
          },
        };
        prepareGatewayRecipientProfile(client);
        return client;
      };
      const source = "agent:main:child";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: source },
        {
          sessionId: "profile-owned-approvals",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: profiles.creator! },
        },
      );
      for (const identityId of [profiles.raiser!, profiles.other!]) {
        await addSessionMemberInWorker(
          { agentId: "main", sessionKey: source },
          { identityId, addedBy: profiles.creator! },
        );
      }
      const reviewers = ["raiser", "other", "creator"];
      const databaseOptions = { env: state.env };
      const managers = createManagers(databaseOptions);
      const handlers = createHandlers(managers, databaseOptions, {
        systemAgentApprovalManager: managers.systemAgent,
      });
      const invoke = bindApprovalHandlers(handlers);
      const context = { ...createContext(), getRuntimeConfig: () => cfg };
      const own = peer("raiser"),
        other = peer("other"),
        creator = peer("creator");
      try {
        const exec = await registerExec(managers.exec, {
          id: "profile-exec",
          reviewerDeviceIds: reviewers,
          requester: { profileId: profiles.raiser! },
        });
        const plugin = await registerPlugin(managers.plugin, {
          id: "plugin:profile",
          reviewerDeviceIds: reviewers,
          profileId: profiles.raiser!,
        });
        const system = await registerSystemAgent(
          managers.systemAgent,
          "system-agent:profile",
          profiles.raiser!,
        );
        const legacy = await registerExec(managers.exec, {
          id: "legacy-profile",
          reviewerDeviceIds: reviewers,
        });
        for (const [kind, id] of [
          ["exec", exec.record.id],
          ["plugin", plugin.record.id],
          ["system-agent", system.record.id],
        ] as const) {
          expect((await getOperatorApproval({ id, databaseOptions }))?.requester.profileId).toBe(
            profiles.raiser,
          );
          expect(await invoke("approval.get", { id }, other, context)).toMatchObject({
            ok: false,
            error: { details: { reason: "APPROVAL_NOT_FOUND" } },
          });
          expect(
            await invoke("approval.resolve", { id, kind, decision: "deny" }, other, context),
          ).toMatchObject({ ok: false });
          expect(await invoke("approval.get", { id }, own, context)).toMatchObject({
            ok: true,
          });
          expect(await invoke("approval.get", { id }, creator, context)).toMatchObject({
            ok: true,
          });
        }
        const runtimeReaders = bindApprovalHandlers({
          ...createExecApprovalHandlers(managers.exec),
          ...createPluginApprovalHandlers(managers.plugin),
          ...systemAgentApprovalHandlers,
        });
        for (const name of ["raiser", "other"] as const) {
          const runtime = createSyntheticPluginRuntimeClient({
            scopes: ["operator.approvals"],
            operatorRoleActor: { kind: "operator", profileId: profiles[name]! },
            operatorRunAuthority: createTestOperatorAuthority({
              profileId: profiles[name]!,
              scopes: ["operator.approvals"],
              assertCurrent() {},
              readCurrentRoleFacts: () => ({
                assignedRole: "invited",
                policy: cfg.gateway!.roles!.definitions.invited,
              }),
            }),
          });
          const runtimeContext = { ...context, systemAgentApprovalManager: managers.systemAgent };
          expect(runtime.authenticatedUserProfile).toBeUndefined();
          for (const [kind, id] of [
            ["exec", exec.record.id],
            ["plugin", plugin.record.id],
            ["openclaw", system.record.id],
          ] as const) {
            expect(
              await runtimeReaders(`${kind}.approval.list`, {}, runtime, runtimeContext),
            ).toMatchObject({
              ok: true,
              result: name === "raiser" ? [expect.objectContaining({ id })] : [],
            });
          }
          expect(
            await runtimeReaders(
              "exec.approval.get",
              { id: exec.record.id },
              runtime,
              runtimeContext,
            ),
          ).toMatchObject({ ok: name === "raiser" });
        }
        for (const admin of [false, true]) {
          const reviewer = createSocketClient({
            deviceId: admin ? "cross-device-admin" : "cross-device-creator",
            profileId: admin ? profiles.admin : profiles.creator,
            scopes: admin ? ["operator.admin"] : ["operator.approvals"],
          });
          prepareGatewayRecipientProfile(reviewer);
          const execReview = await registerExec(managers.exec, {
            id: `cross-device-exec-${admin}`,
            reviewerDeviceIds: [admin ? "cross-device-admin" : "cross-device-creator"],
            requester: { profileId: profiles.raiser! },
          });
          const pluginReview = await registerPlugin(managers.plugin, {
            id: `plugin:cross-device-${admin}`,
            reviewerDeviceIds: [admin ? "cross-device-admin" : "cross-device-creator"],
            profileId: profiles.raiser!,
          });
          const legacyHandlers = {
            ...createExecApprovalHandlers(managers.exec),
            ...createPluginApprovalHandlers(managers.plugin),
          };
          for (const [kind, approval] of [
            ["exec", execReview],
            ["plugin", pluginReview],
          ] as const) {
            const outcome = await createApprovalInvocation({
              handlers: legacyHandlers,
              method: `${kind}.approval.resolve`,
              body: { id: approval.record.id, decision: "deny" },
              client: reviewer,
              context,
            }).invoke();
            expect(outcome).toMatchObject({ ok: true });
            expect(await approval.decision).toBe("deny");
            expect(
              (await getOperatorApproval({ id: approval.record.id, databaseOptions }))?.status,
            ).toBe("denied");
          }
        }
        const visibility = { getCfg: () => cfg, client: own };
        expect(
          (await listVisiblePendingApprovalRequests({ ...visibility, manager: managers.exec })).map(
            (r) => r.id,
          ),
        ).toEqual([exec.record.id]);
        expect(
          (
            await listVisiblePendingApprovalRequests({ ...visibility, manager: managers.plugin })
          ).map((r) => r.id),
        ).toEqual([plugin.record.id]);
        expect(
          (
            await listVisiblePendingApprovalRequests({
              ...visibility,
              manager: managers.systemAgent,
            })
          ).map((r) => r.id),
        ).toEqual([system.record.id]);
        expect(
          await listVisiblePendingApprovalRequests({
            ...visibility,
            client: other,
            manager: managers.exec,
          }),
        ).toEqual([]);
        expect(await invoke("approval.get", { id: legacy.record.id }, own, context)).toMatchObject({
          ok: false,
        });
        expect(
          await invoke("approval.get", { id: legacy.record.id }, creator, context),
        ).toMatchObject({ ok: true });
        for (const [kind, id] of [
          ["exec", exec.record.id],
          ["plugin", plugin.record.id],
          ["system-agent", system.record.id],
        ] as const) {
          expect(
            await invoke("approval.resolve", { id, kind, decision: "deny" }, own, context),
          ).toMatchObject({ ok: true });
        }
        expect(await invoke("approval.history", {}, other, context)).toMatchObject({
          ok: true,
          result: { items: [] },
        });
        const history = await invoke("approval.history", {}, own, context);
        expect(history).toMatchObject({
          ok: true,
          result: {
            items: expect.arrayContaining([
              expect.objectContaining({ id: exec.record.id }),
              expect.objectContaining({ id: plugin.record.id }),
              expect.objectContaining({ id: system.record.id }),
            ]),
          },
        });
      } finally {
        await cleanupApprovalHandlerFixtures();
        catalog.release();
      }
    },
  );
});

it("preserves legacy unprofiled, admin and internal-runtime approval readers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const managers = createManagers({ env: state.env });
    const handlers = {
      ...createExecApprovalHandlers(managers.exec),
      ...createPluginApprovalHandlers(managers.plugin),
    };
    const readers = [
      { client: createClient({ deviceId: "requester-device" }), allowed: true },
      { client: createClient({ scopes: ["operator.admin"] }), allowed: true },
      { client: createClient({ internal: true }), allowed: true },
    ];
    const request = async (method: string, client: GatewayClient | null, id?: string) => {
      const respond = vi.fn();
      await expectDefined(
        handlers[method],
        "approval reader",
      )({
        req: { id: "reader", type: "req", method },
        params: id ? { id } : {},
        respond,
        client,
        context: createContext(),
        isWebchatConnect: () => false,
      });
      return expectDefined(respond.mock.calls[0], "approval reader response");
    };
    try {
      const bound = await registerExec(managers.exec, { id: "legacy-device" });
      const unbound = await registerExec(managers.exec, {
        id: "legacy-unbound",
        requester: { deviceId: null, clientId: null },
        reviewerDeviceIds: [],
      });
      const plugin = await registerPlugin(managers.plugin, { id: "plugin:legacy-device" });
      for (const { client, allowed } of readers) {
        for (const [kind, ids] of [
          ["exec", [bound.record.id, unbound.record.id]],
          ["plugin", [plugin.record.id]],
        ] as const) {
          const [ok, result] = await request(`${kind}.approval.list`, client);
          expect.soft(ok).toBe(true);
          expect
            .soft(result)
            .toEqual(allowed ? ids.map((id) => expect.objectContaining({ id })) : []);
        }
        for (const { record } of [bound, unbound]) {
          const [ok, , error] = await request("exec.approval.get", client, record.id);
          expect.soft(ok).toBe(allowed);
          if (!allowed) {
            expect.soft(error).toMatchObject({ details: { reason: "APPROVAL_NOT_FOUND" } });
          }
        }
      }
      await managers.exec.resolve(bound.record.id, "deny");
      await managers.exec.resolve(unbound.record.id, "deny");
      await managers.plugin.resolve(plugin.record.id, "deny");
      for (const { client, allowed } of readers) {
        for (const [kind, id] of [
          ["exec", bound.record.id],
          ["exec", unbound.record.id],
          ["plugin", plugin.record.id],
        ] as const) {
          const [ok, result, error] = await request(`${kind}.approval.waitDecision`, client, id);
          expect.soft(ok).toBe(allowed);
          expect
            .soft(allowed ? result : error)
            .toMatchObject(
              allowed ? { id, decision: "deny" } : { message: "approval expired or not found" },
            );
        }
      }
    } finally {
      await cleanupApprovalHandlerFixtures();
    }
  });
});
