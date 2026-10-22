import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createServer, type ViteDevServer } from "vite";
import { expect, it, vi } from "vitest";
import type {
  UsersAuthConnectStatusResult,
  UsersListModelAccountsResult,
  UsersSelfResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { readSelectedUserModelAccountAsync } from "../state/user-model-account-operations.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayClient } from "./client.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import type { RespondFn } from "./server-methods/types.js";
import { usersAuthConnectHandlers } from "./server-methods/users-auth-connect.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import type { GatewayServer } from "./server-public.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";

const key = "sk-ant-api03-openclaw-synthetic-proof-never-a-real-key";
const restricted = "operator.write.no-credential-enrollment" as const;
const provider = "anthropic";
const method = "api-key";
const pluginConfig: OpenClawConfig = {
  plugins: { allow: [provider], entries: { anthropic: { enabled: true } } },
};
const env = {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  VITEST: "1",
  OPENCLAW_GATEWAY_TOKEN: undefined,
  OPENCLAW_GATEWAY_PASSWORD: undefined,
};
const role = (
  scopes: NonNullable<
    NonNullable<OpenClawConfig["gateway"]>["roles"]
  >["definitions"][string]["scopes"],
) => ({ scopes, agents: "*" as const, sessions: { others: "view" as const } });
const roles = () => ({
  default: "full",
  definitions: {
    full: role(["operator.write"]),
    restricted: role([restricted]),
    admin: role(["operator.admin"]),
  },
});
type Request = <T>(name: string, params: Record<string, unknown>) => Promise<T>;

async function nextStep(request: Request, profileId: string, connectId: string) {
  let status: UsersAuthConnectStatusResult | undefined;
  await expect
    .poll(
      async () => {
        const current = await request<UsersAuthConnectStatusResult>("users.authConnect.status", {
          profileId,
          connectId,
        });
        status = current;
        return (
          current.status !== "pending" || Boolean(current.step && current.step.type !== "progress")
        );
      },
      { timeout: 15000, interval: 20 },
    )
    .toBe(true);
  return status!;
}
async function start(request: Request, profileId: string) {
  return request<{ connectId: string }>("users.authConnect.start", { profileId, provider, method });
}
async function finish(request: Request, profileId: string, connectId: string) {
  for (let count = 0; count < 6; count++) {
    const status = await nextStep(request, profileId, connectId);
    if (status.status !== "pending") {
      return status;
    }
    const step = status.step!;
    const value = step.type === "text" ? key : step.type === "confirm" ? true : undefined;
    await request("users.authConnect.answer", {
      profileId,
      connectId,
      stepId: step.id,
      ...(value !== undefined ? { value } : {}),
    });
  }
  throw new Error("API-key wizard did not reach its storage outcome");
}

it("enrolls through real WebSocket discovery, shipped provider execution and private storage; restricted users retain saved accounts", async () => {
  const state = await createOpenClawTestState({ label: "personal-provider-production", env });
  const clients: GatewayClient[] = [];
  const proxies: ViteDevServer[] = [];
  let server: GatewayServer | undefined;
  await runQaGatewayFixture(
    async () => {
      const person = ensureProfileForEmail("enrollment-proof@example.test");
      const adminProfile = ensureProfileForEmail("enrollment-admin@example.test");
      setUserProfileRole(person.id, "full");
      setUserProfileRole(adminProfile.id, "admin");
      const port = await getFreePort();
      const origin = "http://127.0.0.1:19652";
      const trustedProxy = {
        allowLoopback: true,
        allowUsers: ["enrollment-proof@example.test", "enrollment-admin@example.test"],
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
      };
      await state.writeConfig({
        ...pluginConfig,
        agents: {
          ownership: "explicit",
          defaults: { workspace: state.workspaceDir },
          entries: { main: { workspace: state.workspaceDir } },
        },
        models: { catalogRefresh: { enabled: false } },
        gateway: {
          port,
          trustedProxies: ["127.0.0.1", "::1"],
          auth: { mode: "trusted-proxy", trustedProxy },
          controlUi: { enabled: false, allowedOrigins: [origin] },
          roles: roles(),
        },
      });
      const { startGatewayServer } = await import("./server.js");
      server = await startGatewayServer(port, {
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      for (const email of ["enrollment-proof@example.test", "enrollment-admin@example.test"]) {
        const proxy = await createServer({
          configFile: false,
          envFile: false,
          root: state.workspaceDir,
          appType: "custom",
          logLevel: "error",
          server: {
            host: "127.0.0.1",
            port: 0,
            proxy: {
              "/": {
                target: "http://127.0.0.1:" + port,
                ws: true,
                headers: {
                  "x-forwarded-for": "192.0.2.20",
                  "x-forwarded-proto": "http",
                  "x-forwarded-user": email,
                },
              },
            },
          },
        });
        proxies.push(proxy);
        await proxy.listen();
        const url = new URL(proxy.resolvedUrls!.local[0]!);
        url.protocol = "ws:";
        clients.push(
          await connectGatewayClient({
            url: url.href,
            origin,
            clientName: "openclaw-control-ui",
            mode: "webchat",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            platform: email,
          }),
        );
      }
      const admin = clients[1]!;
      let client = clients[0]!;
      const reconnectPerson = async () => {
        await client.stopAndWait();
        const url = new URL(proxies[0]!.resolvedUrls!.local[0]!);
        url.protocol = "ws:";
        client = await connectGatewayClient({
          url: url.href,
          origin,
          clientName: "openclaw-control-ui",
          mode: "webchat",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          platform: "enrollment-proof@example.test",
        });
        clients.push(client);
      };
      const request: Request = (name, params) => client.request(name, params);
      const self = await request<UsersSelfResult>("users.self", {});
      expect(self.profile?.id).toBe(person.id);
      const catalog = await request<{
        providers: Array<{ id: string; methods: Array<{ id: string }> }>;
      }>("users.authConnect.catalog", { profileId: person.id });
      expect(catalog.providers).toContainEqual(
        expect.objectContaining({
          id: provider,
          methods: expect.arrayContaining([expect.objectContaining({ id: method })]),
        }),
      );
      const flow = await start(request, person.id);
      const connected = await finish(request, person.id, flow.connectId);
      expect(connected.status).toBe("connected");
      if (connected.status !== "connected") {
        throw new Error("Provider enrollment failed");
      }
      const accountId = connected.authProfileId;
      const privateAccount = await readSelectedUserModelAccountAsync(person.id, provider);
      expect(privateAccount?.credential).toMatchObject({ type: "api_key", provider, key });
      await admin.request("users.setRole", { profileId: person.id, role: "restricted" });
      await reconnectPerson();
      await request("users.unlinkAuthProfile", { profileId: person.id, provider });
      await request("users.selectModelAccount", { profileId: person.id, authProfileId: accountId });
      const inventory = await request<UsersListModelAccountsResult>("users.listModelAccounts", {
        profileId: person.id,
      });
      expect(inventory.accounts).toMatchObject([{ authProfileId: accountId, selected: true }]);
      expect(JSON.stringify(inventory)).not.toContain(key);
      await expect(start(request, person.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await request("users.unlinkAuthProfile", { profileId: person.id, provider });
      await admin.request("users.setRole", { profileId: person.id, role: "full" });
      await reconnectPerson();
      const pending = await start(request, person.id);
      const step = await nextStep(request, person.id, pending.connectId);
      expect(step.status).toBe("pending");
      if (step.status !== "pending" || !step.step) {
        throw new Error("Provider wizard has no pending input");
      }
      await admin.request("users.setRole", { profileId: person.id, role: "restricted" });
      await reconnectPerson();
      await expect(
        request("users.authConnect.answer", {
          profileId: person.id,
          connectId: pending.connectId,
          stepId: step.step.id,
          value: key,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(
        (
          await request<UsersListModelAccountsResult>("users.listModelAccounts", {
            profileId: person.id,
          })
        ).accounts,
      ).toHaveLength(1);
      expect(await request("users.listAuthLinks", { profileId: person.id })).toEqual({ links: [] });
      console.info("personal-enrollment-production-proof", {
        shippedProvider: provider,
        method,
        storedCredential: true,
        savedAccountSelectionUnderRestrictedWrite: true,
        pendingWithdrawal: "FORBIDDEN",
        secretsAbsentFromInventory: true,
      });
    },
    () => Promise.all(clients.map((client) => client.stopAndWait())),
    () => Promise.all(proxies.map((proxy) => proxy.close())),
    () => server?.close({ reason: "personal provider production proof cleanup" }),
    () => state.cleanup(),
  );
}, 120000);

it.each(["transaction", "commit"] as const)(
  "withdraws real API-key enrollment authority at SQLite %s admission",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal", env }, async () => {
      const profile = ensureProfileForEmail("provider-storage-proof@example.test");
      setUserProfileRole(profile.id, "full");
      let config: OpenClawConfig = { ...pluginConfig, gateway: { roles: roles() } };
      const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] });
      const context = createContext([], () => config);
      context.getClientConnIds = (filter) =>
        new Set(!filter || filter(client) ? [client.connId!] : []);
      const service = createModelAccountConnectService({ getConfig: () => config });
      context.modelAccountConnectService = service;
      const request: Request = async <T>(name: string, params: Record<string, unknown>) => {
        const respond = vi.fn<RespondFn>();
        const handler = usersAuthConnectHandlers[name];
        if (!handler) {
          throw new Error("Missing personal-account handler: " + name);
        }
        await handler({
          req: { type: "req", id: "provider-storage-proof", method: name, params },
          params,
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        });
        const [ok, payload, error] = respond.mock.calls[0]!;
        if (!ok) {
          throw new Error(error?.message ?? "Personal-account request failed");
        }
        return payload as T;
      };
      let armed = false;
      const observed: string[] = [];
      const admission = sqliteWorkerOwnerProbe.admission(
        workerAdmission,
        (admissionRequest, grant, admit) => {
          if (
            armed &&
            isRecord(admissionRequest.facts) &&
            admissionRequest.facts.kind === "model-account-links"
          ) {
            observed.push(admissionRequest.stage);
            if (admissionRequest.stage === stage) {
              config = {
                ...config,
                gateway: {
                  roles: {
                    ...roles(),
                    definitions: { ...roles().definitions, full: role([restricted]) },
                  },
                },
              };
            }
          }
          admit(admissionRequest, grant);
        },
      );
      try {
        const flow = await start(request, profile.id);
        const step = await nextStep(request, profile.id, flow.connectId);
        expect(step.status).toBe("pending");
        armed = true;
        const result = await finish(request, profile.id, flow.connectId);
        expect(result.status).toBe("failed");
        expect(observed).toContain(stage);
        expect(
          (
            await request<UsersListModelAccountsResult>("users.listModelAccounts", {
              profileId: profile.id,
            })
          ).accounts,
        ).toEqual([]);
        expect(await request("users.listAuthLinks", { profileId: profile.id })).toEqual({
          links: [],
        });
        expect(await readSelectedUserModelAccountAsync(profile.id, provider)).toBeUndefined();
        console.info("personal-enrollment-storage-proof", {
          stage,
          credentialAndLinkCommitted: false,
          providerExecution: "shipped implementation",
          admission: "observer forwards to original owner",
        });
      } finally {
        admission.mockRestore();
        await service.stop();
      }
    });
  },
  60000,
);
