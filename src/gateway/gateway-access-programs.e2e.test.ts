import { X509Certificate } from "node:crypto";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { createAuthorityGatewayTestEnv } from "./test-helpers.env.js";

const programs = ["daybreak_blue", "daybreak_red"] as const;
const roleGrants: Record<string, Array<(typeof programs)[number]>> = {
  standard: [],
  blue: ["daybreak_blue"],
  red: ["daybreak_red"],
  both: [...programs],
};
const scopes: GatewayOperatorRoleDefinition["scopes"] = [
  "operator.admin",
  "operator.read",
  "operator.write",
];
const origin = "https://control.example.test";
const email = (role: string) => role + "@access.example.test";
const headers = (role: string) => ({
  "x-forwarded-for": "203.0.113.81",
  "x-forwarded-proto": "https",
  "x-forwarded-user": email(role),
});

it(
  "enforces explicit role grants through authenticated session RPCs without model restrictions",
  { timeout: 90_000 },
  () =>
    withOpenClawTestState(
      { label: "daybreak-role-rpc", env: createAuthorityGatewayTestEnv() },
      async (state) => {
        for (const role of Object.keys(roleGrants)) {
          setUserProfileRole(ensureProfileForEmail(email(role)).id, role);
        }
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: {} },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: "openai/access-fixture",
            },
          },
          gateway: {
            auth: {
              mode: "trusted-proxy",
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowLoopback: true,
                allowUsers: Object.keys(roleGrants).map(email),
                deviceAutoApprove: { enabled: true, scopes },
              },
            },
            controlUi: { allowedOrigins: [origin] },
            trustedProxies: ["127.0.0.1"],
            tls: {
              enabled: true,
              autoGenerate: false,
              certPath: await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM),
              keyPath: await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM),
            },
            roles: {
              default: "standard",
              definitions: Object.fromEntries(
                Object.entries(roleGrants).map(([role, cyber]) => [
                  role,
                  {
                    agents: "*",
                    sessions: { others: "none" },
                    scopes,
                    ...(cyber.length ? { accessPrograms: { cyber } } : {}),
                  },
                ]),
              ),
            },
          },
          plugins: { enabled: false, slots: { memory: "none" } },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              openai: {
                baseUrl: "https://provider.example.invalid/v1",
                api: "openai-responses",
                models: [modelDefinition("access-fixture", { reasoning: false, maxTokens: 1024 })],
              },
            },
          },
          cron: { enabled: false },
          update: { checkOnStart: false },
        };
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
        await runQaGatewayFixture(
          async () => {
            const connection = {
              tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
              clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              origin,
              scopes,
            };
            gateway = await startGatewayWithClient({
              ...connection,
              cfg,
              configPath: state.configPath,
              auth: cfg.gateway?.auth,
              secure: true,
              edgeAuthHeaders: headers("standard"),
            });
            clients.push(gateway.client);
            await gateway.server.startupSettled;
            for (const [role, grants] of Object.entries(roleGrants)) {
              const client =
                role === "standard"
                  ? gateway.client
                  : await connectGatewayClient({
                      ...connection,
                      url: "wss://127.0.0.1:" + gateway.port,
                      edgeAuthHeaders: headers(role),
                      deviceIdentity: loadOrCreateDeviceIdentity({
                        path: state.path(role, "client", "credentials.sqlite"),
                      }),
                    });
              if (role !== "standard") {
                clients.push(client);
              }
              const key = "agent:main:dashboard:access-" + role;
              // Match the New Session UI contract: an unselected draft submits Standard.
              const created = await client.request<{ key: string }>("sessions.create", {
                key,
                agentId: "main",
                cyberAccessProgram: "standard",
              });
              expect(created.key).toBe(key);
              const read = () =>
                client.request<{ sessions: Array<{ key: string; cyberAccessProgram?: string }> }>(
                  "sessions.list",
                  { agentId: "main" },
                );
              const selected = async () => {
                const row = (await read()).sessions.find((item) => item.key === key);
                expect(row, "created session must be visible to its owner").toBeDefined();
                return row?.cyberAccessProgram;
              };
              expect(await selected()).toBe("standard");
              for (const program of programs) {
                const patch = () =>
                  client.request("sessions.patch", { key, cyberAccessProgram: program });
                if (grants.includes(program)) {
                  await patch();
                  expect(await selected()).toBe(program);
                  await client.request("sessions.reset", { key, reason: "new" });
                  expect(await selected()).toBe(program);
                } else {
                  const before = await selected();
                  await expect(patch()).rejects.toThrow(
                    "operator role cannot use this Access level",
                  );
                  expect(await selected()).toBe(before);
                  await expect(
                    client.request("sessions.create", {
                      key: key + "-" + program,
                      agentId: "main",
                      cyberAccessProgram: program,
                    }),
                  ).rejects.toThrow("operator role cannot use this Access level");
                }
              }
              await client.request("sessions.patch", { key, cyberAccessProgram: "standard" });
              expect(await selected()).toBe("standard");
            }
          },
          async () => {
            await Promise.all(clients.map(disconnectGatewayClient));
          },
          () => gateway?.server.close({ reason: "explicit Access grant RPC proof finished" }),
        );
      },
    ),
);
