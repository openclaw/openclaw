import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildQaGatewayConfig } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { MODEL_REF } from "./cloud-worker-midturn-loss-fixture.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

export type ProfileWireProvider = {
  baseUrl: string;
  stop(): Promise<void>;
  release?: () => void;
};
export type ProfileWireFixture<P extends ProfileWireProvider> = {
  instance: OpenClawTestInstance;
  provider: P;
  admin: SkillLibraryWireClient;
  alice: SkillLibraryWireClient;
  bob: SkillLibraryWireClient;
  aliceId: string;
  bobId: string;
  reconnectAlice: () => Promise<SkillLibraryWireClient>;
  createSession: (suffix: string, owner?: "alice" | "bob") => Promise<string>;
};

// Shared by Vitest and the native process harness; importing setup must not initialize Vitest.
export async function runProfileWireProof<P extends ProfileWireProvider>(
  startProvider: () => Promise<P>,
  proof: (fixture: ProfileWireFixture<P>) => Promise<void>,
  prepare?: (fixture: {
    instance: OpenClawTestInstance;
    provider: P;
    config: OpenClawConfig;
  }) => Promise<void>,
) {
  const instance = await createSkillLibraryWireInstance();
  let provider: P | undefined;
  const clients: SkillLibraryWireClient[] = [];
  await runQaGatewayFixture(
    async () => {
      // Keep fixture-owned selectors and OS launch inputs, never inherited operator credentials.
      const childEnvKeys = new Set([
        ...Object.keys(instance.state.envVars),
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "ComSpec",
        "COMSPEC",
        "PATHEXT",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "OPENCLAW_GATEWAY_PORT",
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        "OPENCLAW_SKIP_CANVAS_HOST",
      ]);
      for (const key of Object.keys(instance.env)) {
        if (!childEnvKeys.has(key)) {
          delete instance.env[key];
        }
      }
      provider = await startProvider();
      const authConfig = JSON.parse(
        await fs.readFile(instance.configPath, "utf8"),
      ) as OpenClawConfig;
      const config = buildQaGatewayConfig({
        bind: "loopback",
        gatewayPort: instance.port,
        gatewayToken: instance.gatewayToken,
        workspaceDir: instance.state.workspaceDir,
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        controlUiEnabled: false,
        enabledPluginIds: ["openai", "canvas"],
      });
      const gatewayConfig: OpenClawConfig = {
        ...config,
        // Preserve the proxy identity and scope caps, not just the auth-mode field.
        gateway: authConfig.gateway,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            models: {
              ...config.agents?.defaults?.models,
              [MODEL_REF]: {
                ...config.agents?.defaults?.models?.[MODEL_REF],
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
        tools: { ...config.tools, codeMode: false, exec: { mode: "full" } },
      };
      await prepare?.({ instance, provider, config: gatewayConfig });
      await instance.state.writeConfig(gatewayConfig);
      instance.env.OPENCLAW_SKIP_CANVAS_HOST = "0";
      await instance.startGateway();
      const connect = async (options?: Parameters<typeof SkillLibraryWireClient.connect>[1]) => {
        const connected = await SkillLibraryWireClient.connect(instance, options);
        clients.push(connected.client);
        return connected;
      };
      const { client: admin, hello } = await connect();
      assert(hello.auth?.scopes.includes("operator.admin"));
      const { client: aliceAdmin, hello: aliceAdminHello } = await connect({
        email: SKILL_LIBRARY_ALICE,
        scopes: ["operator.admin", ...SKILL_LIBRARY_WRITER_SCOPES],
        buildId: hello.server.buildId,
      });
      assert(aliceAdminHello.auth?.scopes.includes("operator.admin"));
      const connectWriter = async (email: string) => {
        const connected = await connect({ email, buildId: hello.server.buildId });
        assert.deepEqual(
          connected.hello.auth?.scopes?.toSorted(),
          [...SKILL_LIBRARY_WRITER_SCOPES].toSorted(),
        );
        return connected.client;
      };
      const alice = await connectWriter(SKILL_LIBRARY_ALICE);
      const bob = await connectWriter(SKILL_LIBRARY_BOB);
      type Self = { profile: { id: string } };
      const aliceId = (await alice.request<Self>("users.self", {})).profile.id;
      const bobId = (await bob.request<Self>("users.self", {})).profile.id;
      assert.equal(typeof aliceId, "string");
      assert.equal(typeof bobId, "string");
      assert(aliceId.length > 0);
      assert(bobId.length > 0);
      assert.notEqual(aliceId, bobId);
      await proof({
        instance,
        provider,
        admin,
        alice,
        bob,
        aliceId,
        bobId,
        reconnectAlice: () => connectWriter(SKILL_LIBRARY_ALICE),
        createSession: async (suffix, owner = "alice") => {
          const key = `agent:qa:profile-binding-${suffix}`;
          await (owner === "alice" ? aliceAdmin : bob).request("sessions.create", {
            key,
            agentId: "qa",
            displayName: `Profile binding ${suffix}`,
            visibility: "shared",
            ...(owner === "alice" ? { permissionMode: "full" } : {}),
            worktree: false,
            cwd: instance.state.workspaceDir,
          });
          if (owner === "bob") {
            // The creator remains Bob; the separate fixture admin grants the exec proof's mode.
            await admin.request("sessions.patch", { key, permissionMode: "full" });
          }
          for (const client of [alice, bob]) {
            const described = await client.request<{
              session: { key: string; agentRuntime: { id: string } };
            }>("sessions.describe", { key });
            assert.equal(described.session.key, key);
            assert.equal(described.session.agentRuntime.id, "openclaw");
            const history = await client.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: key,
              limit: 100,
            });
            assert.deepEqual(history.messages, []);
          }
          return key;
        },
      });
    },
    () => provider?.release?.(),
    () =>
      runQaGatewayFixture(
        async () => {},
        ...clients.toReversed().map((client) => () => client.close()),
      ),
    () => instance.cleanup(),
    () => provider?.stop(),
  );
}
