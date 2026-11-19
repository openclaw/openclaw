import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
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
import { createContext } from "./approval.test-support.js";
import type { GatewayClient } from "./types.js";

it("enforces durable creator/raiser ownership across generic lookup, resolution, history and each pending family", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const profiles = Object.fromEntries(
        ["creator", "raiser", "other"].map((name) => [
          name,
          ensureProfileForEmail(`${name}@approval.test`).id,
        ]),
      );
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
          requester: { profileId: profiles.raiser! },
        });
        const plugin = await registerPlugin(managers.plugin, {
          id: "plugin:profile",
          profileId: profiles.raiser!,
        });
        const system = await registerSystemAgent(
          managers.systemAgent,
          "system-agent:profile",
          profiles.raiser!,
        );
        const legacy = await registerExec(managers.exec, { id: "legacy-profile" });
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
