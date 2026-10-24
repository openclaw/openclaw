import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  readProviderBody,
  writeToolCall,
} from "../../../../src/gateway/gateway-provider-fixture.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../../../src/infra/device-identity.js";
import { requestDevicePairing } from "../../../../src/infra/device-pairing.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../helpers/openai-responses-model-fixture.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../helpers/tls-fixture.js";
import { isolatedGatewayEnv, writeFixtureReply } from "./gateway-recovery.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function resetGatewayState() {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
}
beforeEach(resetGatewayState);
afterEach(resetGatewayState);

type Job = { id: string; name: string; enabled: boolean };
type ProviderInput = { type?: string; output?: string };

// Real remote-attributed Android authentication, chat admission, model-tool dispatch,
// and Cron persistence. Only the external model's HTTP responses are deterministic.
it(
  "allows Android admin chat management and rejects narrowed or revoked device authority",
  { timeout: 120_000 },
  async ({ signal }) => {
    const root = tempDirs.make("openclaw-android-automation-proof-");
    const stateDir = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const emptyPlugins = path.join(root, "plugins");
    await Promise.all(
      [stateDir, workspace, emptyPlugins].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const certPath = path.join(root, "cert.pem");
    const keyPath = path.join(root, "key.pem");
    await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
    await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
    const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    const token = "synthetic-android-proof-gateway-token";
    const envPatch = {
      ...isolatedGatewayEnv,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_BUNDLED_PLUGINS_DIR: emptyPlugins,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const envSnapshot = captureEnv([
      ...Object.keys(envPatch),
      "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
      "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
    ]);
    for (const [key, value] of Object.entries(envPatch)) {
      if (value === undefined) deleteTestEnvValue(key);
      else setTestEnvValue(key, value);
    }
    const modelEntered = createDeferred();
    const modelRelease = createDeferred();
    let phase: { action: string; jobId: string; job?: { name: string }; revoke?: boolean };
    let phaseCalls = 0;
    const results: string[] = [];
    const model = await startOpenAiResponsesModelServer({
      modelId: "android-authority-fixture",
      bindError: "Android authority fixture did not bind",
      async onRequest(request, response) {
        const body = JSON.parse(await readProviderBody(request)) as { input?: ProviderInput[] };
        results.push(
          ...(body.input ?? [])
            .filter((input) => input.type === "function_call_output")
            .map((input) => input.output ?? ""),
        );
        phaseCalls += 1;
        if (phaseCalls === 1) {
          if (phase.revoke) {
            modelEntered.resolve();
            await modelRelease.promise;
          }
          writeToolCall(response, "automations", {
            action: phase.action,
            jobId: phase.jobId,
            ...(phase.job ? { job: phase.job } : {}),
          });
        } else {
          writeFixtureReply(
            response,
            "Proof complete.",
            `message-${phaseCalls}`,
            `response-${phaseCalls}`,
          );
        }
      },
    }).catch((error: unknown) => {
      envSnapshot.restore();
      throw error;
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const clients: GatewayClient[] = [];
    try {
      const config: OpenClawConfig = createOpenAiResponsesModelConfig({
        baseUrl: model.baseUrl,
        providerId: "android-proof",
        modelId: "android-authority-fixture",
        reasoning: false,
        toolProfile: "full",
      });
      config.agents = {
        ...config.agents,
        defaults: { ...config.agents?.defaults, workspace },
        entries: { main: {} },
      };
      config.tools = { allow: ["automations"], codeMode: false, toolSearch: false };
      config.gateway = {
        auth: { mode: "token", token },
        trustedProxies: ["127.0.0.1"],
        tls: { enabled: true, autoGenerate: false, certPath, keyPath },
      };
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath: path.join(stateDir, "openclaw.json"),
        token,
        secure: true,
        tlsFingerprint,
        scopes: ["operator.admin"],
      });
      withFastReplyConfig(expectDefined(getRuntimeConfigSnapshot(), "runtime config"));
      const admin = gateway.client;
      const added = await admin.request<Job>("cron.add", {
        name: "Foreign-session confidential fixture",
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "session:agent:main:foreign-owner",
        sessionKey: "agent:main:foreign-owner",
        payload: { kind: "agentTurn", message: "Foreign private payload" },
        delivery: { mode: "none" },
      });
      const connectAndroid = async (name: string, scopes: string[]) => {
        const identity = loadOrCreateDeviceIdentity({
          path: path.join(stateDir, name, "client", "credentials.sqlite"),
        });
        const pairing = await requestDevicePairing(
          {
            deviceId: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            clientId: "openclaw-android",
            clientMode: "ui",
            platform: "android",
            role: "operator",
            scopes,
          },
          stateDir,
        );
        await admin.request("device.pair.approve", { requestId: pairing.request.requestId });
        const client = await connectGatewayClient({
          url: `wss://127.0.0.1:${gateway!.port}`,
          token,
          tlsFingerprint,
          clientName: "openclaw-android",
          mode: "ui",
          platform: "android",
          scopes,
          deviceIdentity: identity,
          // A trusted proxy makes this remote ingress; loopback must not confer local authority.
          edgeAuthHeaders: { "x-forwarded-for": "203.0.113.42", "x-forwarded-proto": "https" },
          onHelloOk: (hello) => expect(hello.auth?.scopes).toEqual(scopes),
        });
        clients.push(client);
        return { client, identity };
      };
      const manager = await connectAndroid("manager", ["operator.admin"]);
      const writer = await connectAndroid("writer", ["operator.write"]);
      const run = async (client: GatewayClient, label: string, action: "get" | "update") => {
        phase = {
          action,
          jobId: added.id,
          ...(action === "update" ? { job: { name: `${label} update` } } : {}),
        };
        phaseCalls = 0;
        results.length = 0;
        const started = await client.request<{ runId: string }>("chat.send", {
          sessionKey: `agent:main:android-${label}-${action}`,
          message: `${action} the existing automation`,
          idempotencyKey: `proof-${label}-${action}`,
        });
        await admin.request(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(phaseCalls).toBeGreaterThanOrEqual(2);
        return results.join("\n");
      };
      expect(await run(manager.client, "manager", "get")).toContain(added.name);
      await run(manager.client, "manager", "update");
      expect(await admin.request("cron.get", { id: added.id })).toMatchObject({
        name: "manager update",
      });
      const deniedRead = await run(writer.client, "writer", "get");
      expect(deniedRead).not.toContain("Foreign private payload");
      expect(deniedRead).not.toContain("manager update");
      expect(deniedRead).toMatch(/not found|not available|scope|permission|denied/i);
      const deniedWrite = await run(writer.client, "writer", "update");
      expect(deniedWrite).toMatch(/not found|not available|scope|permission|denied/i);
      expect(await admin.request("cron.get", { id: added.id })).toMatchObject({
        name: "manager update",
      });
      phase = { action: "update", jobId: added.id, job: { name: "revoked update" }, revoke: true };
      phaseCalls = 0;
      results.length = 0;
      const started = await manager.client.request<{ runId: string }>("chat.send", {
        sessionKey: "agent:main:android-revoked",
        message: "Update the existing automation",
        idempotencyKey: "proof-revoked",
      });
      await withinTest(modelEntered.promise, signal);
      await admin.request("device.token.revoke", {
        deviceId: manager.identity.deviceId,
        role: "operator",
      });
      modelRelease.resolve();
      await admin.request(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      );
      expect(await admin.request("cron.get", { id: added.id })).toMatchObject({
        name: "manager update",
      });
      expect(results.join("\n")).not.toContain("Foreign private payload");
    } finally {
      modelRelease.resolve();
      await Promise.all(clients.map(disconnectGatewayClient));
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Android authority proof complete" });
      }
      await model.close();
      envSnapshot.restore();
    }
  },
);
