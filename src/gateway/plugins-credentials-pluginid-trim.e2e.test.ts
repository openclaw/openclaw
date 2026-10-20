import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const PLUGIN_ID = "credtrim";
const CREDENTIAL_PATH = ["plugins", "entries", PLUGIN_ID, "config", "apiKey"] as const;
const GATEWAY_TOKEN = "plugins-credentials-pluginid-trim-e2e-token";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeCredtrimBundledPlugin(bundledDir: string): Promise<void> {
  const pluginDir = path.join(bundledDir, PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PLUGIN_ID,
        enabledByDefault: true,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: { apiKey: { type: "string" } },
        },
        contracts: { webSearchProviders: [PLUGIN_ID] },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ type: "commonjs", openclaw: { extensions: ["./index.js"] } }, null, 2)}\n`,
  );
  // Inspect must resolve credential descriptors from the public artifact surface,
  // not by activating the runtime entry.
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    "throw new Error('credentials.inspect must not activate the runtime entry');\n",
  );
  await fs.writeFile(
    path.join(pluginDir, "web-search-contract-api.js"),
    `module.exports.createCredtrimWebSearchProvider = () => ({
  id: ${JSON.stringify(PLUGIN_ID)},
  label: "Credtrim Search",
  hint: "",
  envVars: ["CREDTRIM_API_KEY"],
  placeholder: "",
  signupUrl: "",
  credentialLabel: "Credtrim API key",
  credentialPath: ${JSON.stringify(CREDENTIAL_PATH.join("."))},
  getCredentialValue() {},
  setCredentialValue() {},
  createTool() { return null; },
});\n`,
  );
}

describe("plugins.credentials.inspect Gateway E2E", () => {
  it(
    "inspects a live installed plugin credential when pluginId is padded",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...ENV_KEYS]);
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        const home = tempDirs.make("openclaw-cred-pluginid-");
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const workspaceDir = path.join(home, "workspace");
        const bundledDir = path.join(home, "bundled-plugins");
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(workspaceDir, { recursive: true }),
          writeCredtrimBundledPlugin(bundledDir),
        ]);

        for (const [key, value] of Object.entries({
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        })) {
          setTestEnvValue(key, value);
        }

        const paddedPluginId = ` ${PLUGIN_ID} `;
        expect(paddedPluginId).not.toBe(PLUGIN_ID);

        gateway = await startGatewayWithClient({
          cfg: {
            agents: {
              defaults: { workspace: workspaceDir, skipBootstrap: true },
              entries: { main: {} },
            },
            gateway: { auth: { mode: "token", token: GATEWAY_TOKEN } },
            plugins: {
              enabled: true,
              allow: [PLUGIN_ID],
              entries: {
                [PLUGIN_ID]: {
                  enabled: true,
                  config: { apiKey: "synthetic-private-credtrim-key" },
                },
              },
            },
          },
          configPath,
          token: GATEWAY_TOKEN,
          clientDisplayName: "plugins-credentials-pluginid-trim",
          scopes: ["operator.admin"],
        });

        const snapshot = await gateway.client.request<{ hash?: string }>("config.get", {});
        expect(snapshot.hash).toEqual(expect.any(String));

        const inspected = await gateway.client.request<{
          baseHash?: string;
          credential?: { kind?: string; value?: string };
        }>("plugins.credentials.inspect", {
          pluginId: paddedPluginId,
          path: [...CREDENTIAL_PATH],
          baseHash: snapshot.hash,
        });

        expect(inspected).toMatchObject({
          baseHash: snapshot.hash,
          credential: { kind: "literal" },
        });
        expect(inspected.credential).not.toHaveProperty("value");

        process.stdout.write(
          `[plugins.credentials.inspect Gateway RPC proof] ok=true padded=${JSON.stringify(paddedPluginId)} exact=${PLUGIN_ID} kind=${inspected.credential?.kind}\n`,
        );
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        envSnapshot.restore();
      }
    },
  );
});
