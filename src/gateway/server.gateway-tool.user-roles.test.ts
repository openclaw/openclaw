import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../agents/tools/gateway-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as profileWrites from "../state/user-profile-writes.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { listSystemChanges } from "./server-methods/system-changes.js";
import { usersHandlers } from "./server-methods/users.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

it("looks up, assigns and clears a profile role under the original operator", async () => {
  const config = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
          administrator: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
        },
      },
    },
  } satisfies OpenClawConfig;
  await withOpenClawTestState(
    { label: "gateway-tool-user-roles", prepareProfileCatalog: true },
    async (state) => {
      await state.writeConfig(config);
      const admin = await ensureCanonicalUserProfileForEmail("admin@example.test");
      await setCanonicalUserProfileRole(admin.id, "administrator");
      const reader = await ensureCanonicalUserProfileForEmail("reader@example.test");
      const email = "target@example.test";
      const { id: profileId } = await ensureCanonicalUserProfileForEmail(email);
      const context = createContext([], () => config);
      const registry = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors(usersHandlers),
      );
      context.getGatewayMethodRegistry = () => registry;
      const run = async (
        client: ReturnType<typeof createOperatorClient>,
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal; receiptAuthority?: () => boolean },
      ) => {
        const source = expectDefined(
          await prepareGatewayOperatorRunAuthority({ client, context }),
          "operator admission",
        );
        try {
          // A model tool gets the admitted authority, not the original operator's socket.
          return await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:dashboard:role-test",
              operationalRunInstance: { instanceId: "role-instance", runId: "role-run" },
              operatorAuthority: source.authority,
              gatewayContextResolver: () => context,
              receiptAuthority: options?.receiptAuthority ?? (() => true),
            },
            async () =>
              (await createGatewayTool().execute("manage-role", params, options?.signal)).details,
          );
        } finally {
          source.release();
        }
      };
      const adminClient = createOperatorClient({ profileId: admin.id, scopes: ["operator.admin"] });
      const readerClient = createOperatorClient({
        profileId: reader.id,
        scopes: ["operator.read"],
      });
      const lookup = { action: "users.getRole", profileId };
      const setRole = { action: "users.setRole", profileId };
      const inherited = { profileId, role: null, effectiveRole: "reader", roleSource: "default" };
      expect(await run(adminClient, { action: "users.getRole", email })).toEqual(inherited);
      expect(await run(adminClient, { ...setRole, role: "administrator" })).toEqual({
        profileId,
        role: "administrator",
      });
      await expect(run(readerClient, { ...setRole, role: null })).rejects.toThrow("operator.admin");
      await expect(run(adminClient, setRole)).rejects.toThrow("role required");
      await expect(run(adminClient, { ...setRole, role: "undefined-role" })).rejects.toThrow(
        "unknown operator role",
      );
      expect(await run(adminClient, lookup)).toEqual({
        profileId,
        role: "administrator",
        effectiveRole: "administrator",
        roleSource: "assigned",
      });
      expect(await run(adminClient, { ...setRole, role: null })).toEqual({ profileId, role: null });
      expect(await run(adminClient, lookup)).toEqual(inherited);
      // The audit must name the original administrator, not the synthetic Gateway client.
      expect((await listSystemChanges({})).entries.map(({ summary }) => summary)).toEqual([
        `Role for profile ${profileId} cleared (was "administrator") by profile ${admin.id}`,
        `Role for profile ${profileId} changed from no role to "administrator" by profile ${admin.id}`,
      ]);

      for (const boundary of ["abort", "revocation"] as const) {
        const controller = new AbortController();
        let current = true;
        const write = profileWrites.setCanonicalUserProfileRole;
        using pausedWrite = vi.spyOn(profileWrites, "setCanonicalUserProfileRole");
        pausedWrite.mockImplementation((...args) => {
          if (boundary === "abort") {
            controller.abort(new Error("role request canceled before commit"));
          } else {
            current = false;
          }
          return write(...args);
        });
        const pending = run(
          adminClient,
          { ...setRole, role: "administrator" },
          {
            signal: controller.signal,
            receiptAuthority: () => current,
          },
        );
        await pending.catch(() => {});
        expect(pausedWrite).toHaveBeenCalledOnce();
        await expect(pending, `precommit ${boundary}`).rejects.toThrow(
          boundary === "abort" ? "role request canceled" : /authority.*no longer active/i,
        );
        expect(await run(adminClient, lookup)).toEqual(inherited);
        expect((await listSystemChanges({})).entries).toHaveLength(2);
      }

      const controller = new AbortController();
      context.disconnectClientsForUserProfile = vi.fn((changedProfileId) => {
        expect(changedProfileId).toBe(admin.id);
        controller.abort(new Error("committed self-downgrade retired the request"));
      });
      expect(
        await run(
          adminClient,
          { action: "users.setRole", profileId: admin.id, role: "reader" },
          {
            signal: controller.signal,
          },
        ),
      ).toEqual({ profileId: admin.id, role: "reader" });
      expect(controller.signal.aborted).toBe(true);
      expect(context.disconnectClientsForUserProfile).toHaveBeenCalledOnce();
      expect(
        await run(readerClient, { action: "users.getRole", profileId: admin.id }),
      ).toMatchObject({
        role: "reader",
        effectiveRole: "reader",
      });
      await expect(run(adminClient, { ...setRole, role: "administrator" })).rejects.toThrow(
        "Your operator role changed; reconnect before continuing.",
      );
      expect((await listSystemChanges({})).entries.map(({ summary }) => summary)).toEqual([
        `Role for profile ${admin.id} changed from "administrator" to "reader" by profile ${admin.id}`,
        `Role for profile ${profileId} cleared (was "administrator") by profile ${admin.id}`,
        `Role for profile ${profileId} changed from no role to "administrator" by profile ${admin.id}`,
      ]);

      const errorAdmin = await ensureCanonicalUserProfileForEmail("error-admin@example.test");
      await setCanonicalUserProfileRole(errorAdmin.id, "administrator");
      const errorClient = createOperatorClient({
        profileId: errorAdmin.id,
        scopes: ["operator.admin"],
      });
      const errorController = new AbortController();
      context.disconnectClientsForUserProfile = vi.fn(() => {
        errorController.abort(new Error("committed error caller retired"));
      });
      const write = profileWrites.setCanonicalUserProfileRole;
      using failedDelivery = vi.spyOn(profileWrites, "setCanonicalUserProfileRole");
      failedDelivery.mockImplementation(async (...args) => {
        await write(...args);
        throw new Error("committed role result delivery failed");
      });
      await expect(
        run(
          errorClient,
          { action: "users.setRole", profileId: errorAdmin.id, role: "reader" },
          {
            signal: errorController.signal,
          },
        ),
      ).rejects.toThrow("committed role result delivery failed");
      expect(failedDelivery).toHaveBeenCalledOnce();
      expect(errorController.signal.aborted).toBe(true);
      expect(
        await run(readerClient, { action: "users.getRole", profileId: errorAdmin.id }),
      ).toMatchObject({
        role: "reader",
      });
      expect((await listSystemChanges({})).entries.map(({ summary }) => summary)).toEqual([
        `Role for profile ${errorAdmin.id} changed from "administrator" to "reader" by profile ${errorAdmin.id}`,
        `Role for profile ${admin.id} changed from "administrator" to "reader" by profile ${admin.id}`,
        `Role for profile ${profileId} cleared (was "administrator") by profile ${admin.id}`,
        `Role for profile ${profileId} changed from no role to "administrator" by profile ${admin.id}`,
      ]);
    },
  );
});
