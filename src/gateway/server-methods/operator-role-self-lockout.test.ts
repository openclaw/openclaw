import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import type * as ConfigWriteFlowModule from "./config-write-flow.js";
import { replyWithBillingRouteWarnings } from "./config-write-reply.js";
import { configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";
import { expectRpcError } from "./rpc-response.test-support.js";
import { usersHandlers } from "./users.js";

const selfLockoutMessage =
  "This change would remove your administrator access (operator.admin), and you could no longer manage roles. Assign yourself a role that includes operator.admin first, then try again.";

const mocks = vi.hoisted(() => ({ read: vi.fn(), commit: vi.fn() }));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: mocks.read,
}));
vi.mock("../../config/runtime-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-schema.js")>()),
  loadGatewayConfigRedactionHints: () => ({}),
}));
vi.mock("../../secrets/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime.js")>()),
  prepareSecretsRuntimeSnapshot: async ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("./config-write-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigWriteFlowModule>()),
  commitGatewayConfigWrite: mocks.commit,
  resolveGatewayConfigRestartWriteResult: async () => ({
    payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
    sentinelPersisted: false,
    restart: undefined,
  }),
}));

const roles = {
  definitions: {
    admin: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
    viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.sessions.read"] },
  },
} satisfies NonNullable<OpenClawConfig["gateway"]>["roles"];

async function patchDefaultRole(client: ReturnType<typeof createOperatorClient>) {
  const current: OpenClawConfig = { gateway: { roles } };
  mocks.read.mockImplementation(async () => createConfigWriteSnapshot(current));
  mocks.commit.mockImplementation(
    async (params: Parameters<typeof ConfigWriteFlowModule.commitGatewayConfigWrite>[0]) => ({
      path: params.snapshot.path,
      config: params.nextConfig,
      hash: "next-hash",
      queueFollowUp: vi.fn(),
      reply: replyWithBillingRouteWarnings(params.respond, [], undefined),
    }),
  );
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      raw: JSON.stringify({ gateway: { roles: { default: "viewer" } } }),
      baseHash: "base-hash",
    },
    overrides: { client },
  });
  await expectDefined(configHandlers["config.patch"], "config.patch handler")(harness.options);
  return harness.respond;
}

it("refuses a default role that would demote the administrator setting it", async () => {
  await withOpenClawTestState(
    { label: "role-self-lockout-default", prepareProfileCatalog: true },
    async () => {
      const self = await ensureCanonicalUserProfileForEmail("owner@example.test");
      const client = createOperatorClient({ profileId: self.id, scopes: ["operator.admin"] });

      // Unassigned, the default would make the person turning it on a viewer.
      expectRpcError(await patchDefaultRole(client), {
        message: selfLockoutMessage,
      });
      expect(mocks.commit).not.toHaveBeenCalled();

      // The Roles page's order: assign administrators while no default exists, then set it.
      const assigned = vi.fn();
      await expectDefined(
        usersHandlers["users.setRole"],
        "users.setRole handler",
      )({
        req: { type: "req", id: "1", method: "users.setRole" },
        params: { profileId: self.id, role: "admin" },
        client,
        isWebchatConnect: () => false,
        respond: assigned,
        context: createContext([], () => ({ gateway: { roles } })),
      });
      expect(assigned.mock.calls[0]?.[0]).toBe(true);
      const respond = await patchDefaultRole(client);
      expect(mocks.commit).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    },
  );
});

it("refuses an administrator's own demotion but not another person's", async () => {
  const config = { gateway: { roles: { ...roles, default: "viewer" } } } satisfies OpenClawConfig;
  await withOpenClawTestState(
    { label: "role-self-lockout-assignment", prepareProfileCatalog: true },
    async (state) => {
      await state.writeConfig(config);
      const self = await ensureCanonicalUserProfileForEmail("owner@example.test");
      const other = await ensureCanonicalUserProfileForEmail("other@example.test");
      await setCanonicalUserProfileRole(self.id, "admin");
      await setCanonicalUserProfileRole(other.id, "admin");
      const context = createContext([], () => config);
      const client = createOperatorClient({ profileId: self.id, scopes: ["operator.admin"] });
      const setRole = async (profileId: string) => {
        const respond = vi.fn();
        await expectDefined(
          usersHandlers["users.setRole"],
          "users.setRole handler",
        )({
          req: { type: "req", id: "1", method: "users.setRole" },
          params: { profileId, role: "viewer" },
          client,
          isWebchatConnect: () => false,
          respond,
          context,
        });
        return respond;
      };

      expectRpcError(await setRole(self.id), { message: selfLockoutMessage });
      expect((await setRole(other.id)).mock.calls[0]?.[0]).toBe(true);
    },
  );
});
