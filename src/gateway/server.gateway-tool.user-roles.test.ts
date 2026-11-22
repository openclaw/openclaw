import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../agents/tools/gateway-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
              operatorAuthority: source.authority,
              gatewayContextResolver: () => context,
            },
            async () => (await createGatewayTool().execute("manage-role", params)).details,
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
    },
  );
});
