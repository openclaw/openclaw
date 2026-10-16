import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardStartResult } from "../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../test/helpers/promise.js";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfig,
  writeConfigFile,
} from "../config/config.js";
import { resetConfigOverrides, setConfigOverride } from "../config/runtime-overrides.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDeviceAuthTokenForTest } from "../infra/device-auth-store.test-support.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { callGateway } from "./call.js";
import {
  createGatewayConfigPath,
  GATEWAY_TEST_ENV_KEYS,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import {
  connectDeviceAuthReq,
  disconnectGatewayClient,
  connectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";
import { installOpenAiResponsesMock } from "./test-helpers.openai-mock.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;
const envToken = (id: string) => ({ source: "env" as const, provider: "default", id });
const expectLoggingLevel = (level: string) =>
  expect
    .poll(() => getRuntimeConfig().logging?.level, { timeout: 5_000, interval: 50 })
    .toBe(level);

async function startTestGateway(options: Parameters<typeof startGatewayServer>[1] = {}) {
  const claim = await acquireGatewayE2ePortBlock();
  const server = await startClaimedGateway(claim, () =>
    startGatewayServer(claim.port, {
      bind: "loopback",
      controlUiEnabled: false,
      ...options,
    }),
  );
  return { port: claim.port, server };
}

type GatewayServer = Awaited<ReturnType<typeof startGatewayServer>>;
type GatewayClient = Awaited<ReturnType<typeof connectGatewayClient>>;

async function withGatewayHome(
  run: (home: Awaited<ReturnType<typeof setupGatewayHome>>) => Promise<void>,
  minimalGateway = false,
) {
  const home = await setupGatewayHome(minimalGateway);
  try {
    await run(home);
  } finally {
    try {
      for (const client of home.clients) {
        await disconnectGatewayClient(client);
      }
    } finally {
      try {
        for (const server of home.servers) {
          await server.close({ reason: "gateway test complete" });
        }
      } finally {
        try {
          await removeGatewayTempHome(home.tempHome);
        } finally {
          home.envSnapshot.restore();
        }
      }
    }
  }
}

async function setupGatewayHome(minimalGateway: boolean) {
  const home = await setupGatewayTempHome({ prefix: "openclaw-gateway-", minimalGateway });
  const configPath = await createGatewayConfigPath(home.tempHome);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  const servers: GatewayServer[] = [];
  const clients: GatewayClient[] = [];
  return {
    ...home,
    configPath,
    configIO: createConfigIO({ configPath }),
    async updateSource(update: (config: OpenClawConfig) => OpenClawConfig) {
      const { sourceConfig } = await createConfigIO({ configPath }).readConfigFileSnapshot();
      await writeConfigFile(update(sourceConfig));
    },
    servers,
    clients,
    async launch(
      params: Pick<
        Parameters<typeof startGatewayWithClient>[0],
        "cfg" | "token" | "clientDisplayName"
      >,
    ) {
      const result = await startGatewayWithClient({ ...params, configPath });
      servers.push(result.server);
      clients.push(result.client);
      return result;
    },
    async start(options: Parameters<typeof startGatewayServer>[1] = {}) {
      const result = await startTestGateway(options);
      servers.push(result.server);
      return result;
    },
    async connect(port: number, token: string, clientDisplayName: string) {
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientDisplayName,
      });
      clients.push(client);
      return client;
    },
  };
}

async function writeWorkspacePlugin(workspaceDir: string, body: string): Promise<void> {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "http-probe");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "http-probe",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  await fs.writeFile(path.join(pluginDir, "index.cjs"), body, "utf8");
}

describe("gateway e2e", () => {
  let workspacePluginCleanup: Promise<void> | undefined;

  beforeEach(resetGatewayTestState);

  afterEach(async () => {
    try {
      // Vitest starts hooks on timeout without joining the body's async finally.
      await workspacePluginCleanup;
    } finally {
      workspacePluginCleanup = undefined;
      resetGatewayTestState();
    }
  });

  it("pairs the local CLI before a runtime-token loopback gateway becomes ready", async () => {
    await withGatewayHome(async ({ configPath, configIO, start }) => {
      deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
      const initialConfig: OpenClawConfig = {
        gateway: { mode: "local", bind: "loopback" },
        logging: { level: "info" },
      };
      await configIO.writeConfigFile(initialConfig);
      const { port } = await start({ sidecarStartup: "defer" });

      await expect(
        callGateway({
          config: initialConfig,
          localPortOverride: port,
          method: "health",
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual(expect.any(Object));

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persisted.gateway?.auth?.token).toBeUndefined();
      const identity = loadOrCreateDeviceIdentity();
      expect(
        readDeviceAuthTokenForTest({ deviceId: identity.deviceId, role: "operator" }),
      ).toMatchObject({
        scopes: expect.arrayContaining(["operator.admin"]),
      });
      await expect(getPairedDevice(identity.deviceId)).resolves.toMatchObject({
        approvedVia: "silent",
        approvedScopes: expect.arrayContaining(["operator.admin"]),
      });
    }, true);
  });

  it.each(["generated", "explicit-override", "secret-ref-override", "runtime-overrides"] as const)(
    "preserves %s auth across a safe direct gateway reload",
    async (authSource) => {
      await withGatewayHome(async ({ configPath, configIO, start, connect }) => {
        deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
        const fileToken = nextGatewayId("direct-file-token");
        const overrideToken = nextGatewayId("direct-override-token");
        const initialConfig: OpenClawConfig = { logging: { level: "info" } };
        if (authSource !== "generated") {
          initialConfig.gateway = {
            auth: {
              mode: "token",
              token:
                authSource === "secret-ref-override"
                  ? envToken("OPENCLAW_TEST_MISSING_DISK_TOKEN")
                  : fileToken,
            },
          };
        }
        if (authSource === "runtime-overrides") {
          initialConfig.channels = { whatsapp: { dmPolicy: "pairing" } };
        }
        await configIO.writeConfigFile(initialConfig);
        if (authSource === "secret-ref-override") {
          setTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", overrideToken);
        }
        if (authSource === "runtime-overrides") {
          deleteTestEnvValue("OPENCLAW_SKIP_CHANNELS");
          deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");
          setTestEnvValue("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN", overrideToken);
          expect(
            setConfigOverride(
              "gateway.auth.token",
              envToken("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN"),
            ).ok,
          ).toBe(true);
          expect(
            setConfigOverride("channels.whatsapp", { dmPolicy: "open", allowFrom: ["*"] }).ok,
          ).toBe(true);
        }
        const callerAuthOverride: GatewayAuthConfig | undefined =
          authSource === "explicit-override"
            ? {
                mode: "token" as const,
                token: overrideToken,
                rateLimit: { maxAttempts: 7 },
              }
            : authSource === "secret-ref-override"
              ? {
                  mode: "token",
                  token: envToken("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN"),
                }
              : undefined;
        const callerTailscaleOverride: GatewayTailscaleConfig | undefined =
          authSource === "explicit-override"
            ? { mode: "off" as const, preserveFunnel: true }
            : undefined;
        const { port } = await start({
          auth: callerAuthOverride,
          tailscale: callerTailscaleOverride,
        });
        const expectedToken =
          authSource === "generated" ? getRuntimeConfig().gateway?.auth?.token : overrideToken;
        expect(typeof expectedToken).toBe("string");
        const client = await connect(port, expectedToken as string, "vitest-direct-reload");

        const health = await client.request<{
          configReload?: { hotReloadStatus?: string };
        }>("health", { probe: true });
        expect(health?.configReload?.hotReloadStatus).toBe("active");

        if (authSource === "runtime-overrides") {
          expect(getRuntimeConfig().channels?.whatsapp?.dmPolicy).toBe("open");
        } else if (callerAuthOverride && callerTailscaleOverride) {
          callerAuthOverride.token = `${overrideToken}-mutated`;
          callerAuthOverride.rateLimit!.maxAttempts = 99;
          callerTailscaleOverride.preserveFunnel = false;
        }
        const sourceBeforeLoggingEdit = (await configIO.readConfigFileSnapshot()).sourceConfig;
        const nextLoggingSource = {
          ...sourceBeforeLoggingEdit,
          logging: { ...sourceBeforeLoggingEdit.logging, level: "debug" },
        } satisfies OpenClawConfig;
        const loggingChanges = new Set<string>();
        collectChangedPaths(sourceBeforeLoggingEdit, nextLoggingSource, "", loggingChanges);
        expect([...loggingChanges]).toEqual(["logging.level"]);
        await writeConfigFile(nextLoggingSource);
        await expectLoggingLevel("debug");
        expect(getRuntimeConfig().gateway?.auth?.token).toBe(expectedToken);
        if (authSource === "explicit-override") {
          expect(getRuntimeConfig().gateway?.auth?.rateLimit?.maxAttempts).toBe(7);
          expect(getRuntimeConfig().gateway?.tailscale?.preserveFunnel).toBe(true);
        }
        if (authSource === "runtime-overrides") {
          expect(getRuntimeConfig().channels?.whatsapp?.dmPolicy).toBe("open");
          expect(getRuntimeConfig().channels?.whatsapp?.allowFrom).toEqual(["*"]);

          const sourceBeforePolicyEdit = (await configIO.readConfigFileSnapshot()).sourceConfig;
          const nextPolicySource = {
            ...sourceBeforePolicyEdit,
            channels: {
              ...sourceBeforePolicyEdit.channels,
              whatsapp: {
                ...sourceBeforePolicyEdit.channels?.whatsapp,
                dmPolicy: "disabled",
              },
            },
          } satisfies OpenClawConfig;
          await writeConfigFile(nextPolicySource);
          const persistedPolicyEdit = JSON.parse(
            await fs.readFile(configPath, "utf-8"),
          ) as OpenClawConfig;
          expect(persistedPolicyEdit.channels?.whatsapp?.dmPolicy).toBe("disabled");
          expect(getRuntimeConfig().channels?.whatsapp?.dmPolicy).toBe("open");

          const sourceBeforeUnrelatedWrite = (await configIO.readConfigFileSnapshot()).sourceConfig;
          const nextUnrelatedSource = {
            ...sourceBeforeUnrelatedWrite,
            ui: { seamColor: "#123456" },
          } satisfies OpenClawConfig;
          await writeConfigFile(nextUnrelatedSource);
          const persistedAfterUnrelatedWrite = JSON.parse(
            await fs.readFile(configPath, "utf-8"),
          ) as OpenClawConfig;
          expect(persistedAfterUnrelatedWrite.channels?.whatsapp?.dmPolicy).toBe("disabled");
          expect(persistedAfterUnrelatedWrite.ui?.seamColor).toBe("#123456");
        }

        await connect(port, expectedToken as string, "vitest-direct-reload-reconnect");
      });
    },
  );

  it("refreshes direct hook target policy after hot reload", async () => {
    await withGatewayHome(async ({ tempHome, configPath, configIO, start }) => {
      const gatewayToken = nextGatewayId("hook-policy-gateway-token");
      const hookToken = nextGatewayId("hook-policy-token");
      const fixedSessionStore = path.join(tempHome, ".openclaw", "sessions.json");
      const agentRoster = (id: string): OpenClawConfig["agents"] => ({
        ownership: "explicit",
        defaults: { sessionStore: { agentId: id } },
        entries: { [id]: {} },
      });
      const initialConfig: OpenClawConfig = {
        agents: agentRoster("old"),
        gateway: { auth: { mode: "token", token: gatewayToken } },
        hooks: { enabled: true, token: hookToken, allowedAgentIds: [] },
        session: { scope: "global", store: fixedSessionStore },
      };
      await configIO.writeConfigFile(initialConfig, {
        allowedAgentRosterRemovals: ["main"],
      });
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const { port } = await start({ hotReloadRecovery });
      await expect
        .poll(
          async () => {
            const health = await callGateway({
              config: initialConfig,
              localPortOverride: port,
              method: "health",
              timeoutMs: 5_000,
            });
            return (health as { configReload?: { hotReloadStatus?: string } }).configReload
              ?.hotReloadStatus;
          },
          { timeout: 5_000, interval: 50 },
        )
        .toBe("active");
      const writeConfigAtomically = async (config: OpenClawConfig) => {
        const stagedConfigPath = `${configPath}.next`;
        await fs.writeFile(stagedConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        await fs.rename(stagedConfigPath, configPath);
      };

      const postAgentHook = async (agentId: string) => {
        const response = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${hookToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "policy probe", agentId }),
        });
        return {
          status: response.status,
          body: (await response.json()) as { error?: string },
        };
      };

      const expectRejection = (id: string, error: string) =>
        expect(postAgentHook(id)).resolves.toMatchObject({ status: 400, body: { error } });
      await expectRejection("old", "agentId is not allowed by hooks.allowedAgentIds");
      await expectRejection("new", 'unknown agentId "new"');

      const nextConfig: OpenClawConfig = {
        ...initialConfig,
        agents: agentRoster("new"),
      };
      await writeConfigAtomically(nextConfig);
      await expect
        .poll(
          () => ({
            agentIds: Object.keys(getRuntimeConfig().agents?.entries ?? {}),
            ownerAgentId: getRuntimeConfig().agents?.defaults?.sessionStore?.agentId,
          }),
          { timeout: 5_000, interval: 50 },
        )
        .toEqual({ agentIds: ["new"], ownerAgentId: "new" });

      await expectRejection("new", "agentId is not allowed by hooks.allowedAgentIds");
      await expectRejection("old", 'unknown agentId "old"');
      expect(hotReloadRecovery).not.toHaveBeenCalled();
    });
  });

  it(
    "re-resolves a startup auth SecretRef override when secrets reload",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      await withGatewayHome(async ({ configPath, configIO, start, connect }) => {
        const fileToken = nextGatewayId("startup-auth-file-token");
        const oldToken = nextGatewayId("startup-auth-ref-old");
        const newToken = nextGatewayId("startup-auth-ref-new");
        await configIO.writeConfigFile({
          gateway: { auth: { mode: "token", token: fileToken } },
          logging: { level: "info" },
        });
        setTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", oldToken);
        const { port } = await start({
          auth: {
            mode: "token",
            token: envToken("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN"),
          },
        });
        const oldClient = await connect(port, oldToken, "vitest-startup-auth-ref-old");

        setTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", newToken);
        const reload = await oldClient
          .request<{ ok?: boolean }>("secrets.reload", {})
          .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        if (!(reload instanceof Error)) {
          expect(reload.ok).toBe(true);
        }
        await connect(port, newToken, "vitest-startup-auth-ref-new");

        const sourceBeforeLoggingEdit = (await configIO.readConfigFileSnapshot()).sourceConfig;
        await writeConfigFile({
          ...sourceBeforeLoggingEdit,
          logging: { ...sourceBeforeLoggingEdit.logging, level: "debug" },
        });
        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          gateway?: { auth?: { token?: unknown } };
        };
        expect(persisted.gateway?.auth?.token).toBe(fileToken);
      });
    },
  );

  it("preserves runtime-seeded Control UI origins across a safe direct reload", async () => {
    await withGatewayHome(async ({ configIO, start, updateSource }) => {
      const token = nextGatewayId("direct-origins-token");
      const initialConfig: OpenClawConfig = {
        gateway: { auth: { mode: "token", token } },
        logging: { level: "info" },
      };
      await configIO.writeConfigFile(initialConfig);
      await start({ bind: "lan" });
      const seededOrigins = getRuntimeConfig().gateway?.controlUi?.allowedOrigins;
      expect(seededOrigins?.length).toBeGreaterThan(0);

      await updateSource((source) => ({
        ...source,
        logging: { ...source.logging, level: "debug" },
      }));
      await expectLoggingLevel("debug");
      expect(getRuntimeConfig().gateway?.controlUi?.allowedOrigins).toEqual(seededOrigins);

      expect(setConfigOverride("logging.level", "warn").ok).toBe(true);
      await updateSource((source) => ({
        ...source,
        ui: { ...source.ui, seamColor: "#123456" },
        logging: { ...source.logging, level: "debug" },
      }));
      await expectLoggingLevel("warn");

      resetConfigOverrides();
      await updateSource((source) => ({
        ...source,
        ui: { ...source.ui, seamColor: "#654321" },
        logging: { ...source.logging, level: "debug" },
      }));
      await expectLoggingLevel("debug");
      expect(getRuntimeConfig().gateway?.controlUi?.allowedOrigins).toEqual(seededOrigins);
    });
  });

  it(
    "accepts a gateway agent request over ws and returns a run id",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { baseUrl: openaiBaseUrl, restore } = installOpenAiResponsesMock();
      try {
        await withGatewayHome(async ({ workspaceDir, launch }) => {
          const token = nextGatewayId("test-token");
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);

          const mockProvider = buildMockOpenAiResponsesProvider(openaiBaseUrl);

          const cfg = {
            agents: {
              defaults: {
                workspace: workspaceDir,
                model: { primary: mockProvider.modelRef },
                models: {
                  [mockProvider.modelRef]: {
                    params: {
                      transport: "sse",
                      openaiWsWarmup: false,
                    },
                  },
                },
              },
              entries: { dev: {} },
            },
            models: {
              mode: "replace",
              providers: {
                [mockProvider.providerId]: mockProvider.config,
              },
            },
            gateway: { auth: { token } },
          };

          const { server, client } = await launch({
            cfg,
            token,
            clientDisplayName: "vitest-mock-openai",
          });

          // Agent admission needs the reply runtime published by normal sidecar startup.
          await server.startupSettled;
          const runId = nextGatewayId("run");
          const payload = await client.request(
            "agent",
            {
              sessionKey: "agent:dev:mock-openai",
              idempotencyKey: `idem-${runId}`,
              message: "Reply with ok.",
              deliver: false,
            },
            { expectFinal: false },
          );

          expect(payload).toMatchObject({ status: "accepted", runId: expect.any(String) });

          const abortPayload = await client.request(
            "sessions.abort",
            { runId: payload.runId },
            { timeoutMs: 5_000 },
          );
          expect(["aborted", "no-active-run"]).toContain(abortPayload?.status);
        });
      } finally {
        restore();
      }
    },
  );

  it(
    "does not reload workspace plugins when POST /tools/invoke rebuilds tools for the same workspace",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async ({ signal }) => {
      const run = withGatewayHome(async ({ tempHome, workspaceDir, configPath, start }) => {
        const token = nextGatewayId("http-tools-token");
        setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
        const registerCountPath = path.join(tempHome, "workspace-plugin-register-count.txt");
        await writeWorkspacePlugin(
          workspaceDir,
          `
const fs = require("node:fs");
const counterPath = ${JSON.stringify(registerCountPath)};
module.exports = {
  id: "http-probe",
  register() {
    const current = fs.existsSync(counterPath)
      ? Number.parseInt(fs.readFileSync(counterPath, "utf8").trim(), 10) || 0
      : 0;
    fs.writeFileSync(counterPath, String(current + 1), "utf8");
  },
};
`.trimStart(),
        );

        const cfg = {
          agents: {
            defaults: { workspace: workspaceDir },
            entries: { main: { tools: { allow: ["agents_list"] } } },
          },
          plugins: {
            allow: ["http-probe"],
          },
          gateway: { auth: { token } },
        };
        await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
        const { port, server } = await start({
          auth: { mode: "token", token },
          sidecarStartup: "defer",
        });
        // Startup settles after the fixture's synchronous registration write.
        await withinTest(server.startupSettled, signal);
        const beforeCount = Number.parseInt(await fs.readFile(registerCountPath, "utf8"), 10);
        expect(beforeCount).toBeGreaterThan(0);

        const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify({
            tool: "agents_list",
            action: "json",
            args: {},
            sessionKey: "main",
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);

        const afterCount = Number.parseInt(await fs.readFile(registerCountPath, "utf8"), 10);
        expect(afterCount).toBe(beforeCount);
      });
      workspacePluginCleanup = run.then(
        () => {},
        () => {},
      );
      await run;
    },
  );

  it(
    "runs wizard over ws and writes auth token config",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      await withGatewayHome(
        async ({ configPath, configIO, start: startServer, connect, servers, clients }) => {
          deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
          clearRuntimeConfigSnapshot();
          clearConfigCache();

          const wizardToken = nextGatewayId("wiz-token");
          const { server, port } = await startServer({
            auth: { mode: "token", token: wizardToken },
            wizardRunner: async (_opts, _runtime, prompter) => {
              await prompter.intro("Wizard E2E");
              await prompter.note("write token");
              const token = await prompter.text({ message: "token" });
              await configIO.writeConfigFile({
                gateway: { auth: { mode: "token", token } },
              });
              await prompter.outro("ok");
            },
          });
          const client = await connect(port, wizardToken, "vitest-wizard");

          try {
            const start = await client.request<WizardStartResult>("wizard.start", {
              mode: "local",
            });
            const sessionId = start.sessionId;
            expect(typeof sessionId).toBe("string");

            let next = start;
            let didSendToken = false;
            const seenSteps: string[] = [];
            while (!next.done) {
              const step = next.step;
              if (!step) {
                throw new Error("wizard missing step");
              }
              seenSteps.push(`${step.type}:${step.id}`);
              const value = step.type === "text" ? wizardToken : null;
              if (step.type === "text") {
                didSendToken = true;
              }
              next = await client.request(
                "wizard.next",
                {
                  sessionId,
                  answer: { stepId: step.id, value },
                },
                { timeoutMs: 60_000 },
              );
            }

            expect(
              didSendToken,
              `seenSteps=${seenSteps.join(",")} final=${JSON.stringify(next)}`,
            ).toBe(true);
            expect(next.status).toBe("done");

            // The wizard writes config before its outro and terminal done response.
            const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
            expect(persisted.gateway?.auth?.token).toBe(wizardToken);
          } finally {
            await disconnectGatewayClient(client);
            await server.close({ reason: "wizard e2e complete" });
            clients.splice(clients.indexOf(client), 1);
            servers.splice(servers.indexOf(server), 1);
          }

          const { port: port2 } = await startServer();
          const resNoToken = await connectDeviceAuthReq({
            url: `ws://127.0.0.1:${port2}`,
          });
          expect(resNoToken.ok).toBe(false);
          expect(resNoToken.error?.message ?? "").toContain("unauthorized");

          const resToken = await connectDeviceAuthReq({
            url: `ws://127.0.0.1:${port2}`,
            token: wizardToken,
          });
          expect(resToken.ok).toBe(true);
        },
        true,
      );
    },
  );

  it(
    "returns targeted channel resolution errors without wizard or config effects",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      await withGatewayHome(async ({ configPath, launch }) => {
        const { client } = await launch({
          cfg: {},
          token: nextGatewayId("wiz-channel-target"),
        });
        for (const channel of [" \t ", "unknown-channel"]) {
          const expectedChannel = channel.trim();
          const result = await client.request<WizardStartResult>("wizard.start", {
            flow: "channels",
            channel,
          });
          expect(result).toMatchObject({
            done: true,
            status: "error",
            error: `Unknown channel "${expectedChannel}". Run \`openclaw channels list --all\` to see configured and installable channels.`,
          });
          expect(result.step).toBeUndefined();
        }

        await expect(client.request("health", {})).resolves.toBeDefined();
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}\n");
      }, true);
    },
  );

  it(
    "ignores env-driven plugin auto-enable in minimal gateway mode",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const envSnapshot = captureEnv([...GATEWAY_TEST_ENV_KEYS, "DISCORD_BOT_TOKEN"]);

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimal-gateway-home-"));
      const configPath = await createGatewayConfigPath(tempHome);
      const bundledPluginsDir = path.join(tempHome, "openclaw-test-no-bundled-extensions");
      setTestEnvValue("HOME", tempHome);
      setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempHome, ".openclaw"));
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
      setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
      setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
      setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
      setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
      setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
      setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPluginsDir);
      setTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY", "1");
      setTestEnvValue("DISCORD_BOT_TOKEN", "discord-test-token");

      const token = nextGatewayId("minimal-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      await fs.mkdir(bundledPluginsDir, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { auth: { mode: "token", token } } }, null, 2)}\n`,
      );

      const { server } = await startTestGateway({
        auth: { mode: "token", token },
        sidecarStartup: "defer",
      });

      try {
        const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(parsed.plugins?.entries?.discord).toBeUndefined();
      } finally {
        await server.close({ reason: "minimal gateway auto-enable verify" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );
});
