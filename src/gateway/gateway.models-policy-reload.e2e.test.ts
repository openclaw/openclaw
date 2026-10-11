import { AsyncLocalStorage } from "node:async_hooks";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as policy from "../plugins/provider-policy-surface.js";
import * as artifacts from "../plugins/public-surface-loader.js";
import { getPluginRegistryVersion } from "../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { connectUserModelAccountAsync } from "../state/user-model-account-operations.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { coreGatewayHandlers } from "./server-methods/core-handlers.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reuses provider policy artifacts after a model config hot reload", async () => {
  const home = tempDirs.make("openclaw-models-policy-reload-");
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace);
  const certPath = path.join(home, "cert.pem");
  const keyPath = path.join(home, "key.pem");
  await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
  await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
  vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", undefined);
  vi.stubEnv("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN", undefined);
  for (const name of [
    "CHANNELS",
    "CRON",
    "GMAIL_WATCHER",
    "CANVAS_HOST",
    "BROWSER_CONTROL_SERVER",
    "PROVIDERS",
  ]) {
    vi.stubEnv(`OPENCLAW_SKIP_${name}`, "1");
  }
  const modelIds = Array.from({ length: 100 }, (_, index) => `model-${index}`);
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "openai/model-0" },
        models: Object.fromEntries(modelIds.map((id) => [`openai/${id}`, {}])),
      },
      entries: { main: {} },
    },
    gateway: {
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
          deviceAutoApprove: { enabled: true, scopes: ["operator.read", "operator.write"] },
        },
        identityScopes: { "policy@example.test": ["operator.admin"] },
      },
      controlUi: { allowedOrigins: ["https://control.example.test"] },
      tls: { enabled: true, autoGenerate: false, certPath, keyPath },
    },
    models: {
      mode: "replace",
      providers: {
        openai: {
          baseUrl: "https://provider.invalid/v1",
          api: "openai-completions",
          apiKey: "fixture-key",
          models: modelIds.map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 1024,
          })),
        },
      },
    },
    plugins: { allow: ["openai"], slots: { memory: "none" } },
  };
  // The config watcher validates its own snapshot outside the measured RPCs.
  const modelRequests = new AsyncLocalStorage<boolean>();
  const listModels = coreGatewayHandlers["models.list"]!;
  const listHandler = vi
    .spyOn(coreGatewayHandlers, "models.list")
    .mockImplementation((options) => modelRequests.run(true, () => listModels(options)));
  onTestFinished(() => listHandler.mockRestore());
  const gateway = await startGatewayWithClient({
    cfg: config,
    configPath: path.join(home, "openclaw.json"),
    auth: config.gateway!.auth,
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    secure: true,
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    edgeAuthHeaders: {
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "policy@example.test",
    },
    origin: "https://control.example.test",
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
  let candidateLoads = 0;
  const loadCandidates = artifacts.loadBundledPluginPublicArtifactModuleFromCandidatesSync;
  const candidateLoader = vi
    .spyOn(artifacts, "loadBundledPluginPublicArtifactModuleFromCandidatesSync")
    .mockImplementation((params) => {
      if (modelRequests.getStore()) {
        candidateLoads += 1;
      }
      return loadCandidates(params);
    });
  let policyLookups = 0;
  const versions = new Set<number | undefined>();
  const original = policy.resolveDirectBundledProviderPolicySurface;
  const resolvePolicy = vi
    .spyOn(policy, "resolveDirectBundledProviderPolicySurface")
    .mockImplementation((id) => {
      if (modelRequests.getStore()) {
        policyLookups += 1;
        versions.add(getPluginRegistryVersion(getPluginRegistryForContext()));
      }
      return original(id);
    });
  let authProfileId: string;
  let requestIndex = 0;
  // Equivalent spellings exercise each RPC instead of its one-second response cache.
  const nextRequest = () => {
    const mask = requestIndex++;
    const provider = "openai"
      .split("")
      .map((letter, index) => (mask & (1 << index) ? letter.toUpperCase() : letter))
      .join("");
    return { agentId: "main", authProfileId, provider };
  };
  const measure = async (label: string) => {
    await gateway.client.request("models.list", nextRequest());
    candidateLoads = 0;
    policyLookups = 0;
    listHandler.mockClear();
    versions.clear();
    const timings: number[] = [];
    for (let i = 0; i < 12; i++) {
      const started = performance.now();
      const result = await gateway.client.request<{
        models: { id: string }[];
        accountSelection?: { kind: string };
      }>("models.list", nextRequest());
      expect(result.models.some((model) => model.id === "model-0")).toBe(true);
      expect(result.accountSelection?.kind).toBe("personal");
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        label,
        p50: timings[5],
        p95: timings[11],
        loads: candidateLoads,
        lookups: policyLookups,
        versions: [...versions],
      }),
    );
    expect(listHandler).toHaveBeenCalledTimes(12);
    expect(policyLookups).toBeGreaterThan(0);
    return candidateLoads;
  };
  try {
    await gateway.server.startupSettled;
    const self = await gateway.client.request<{ profile: { id: string } }>("users.self", {});
    ({ authProfileId } = await connectUserModelAccountAsync({
      ownerProfileId: self.profile.id,
      credential: { type: "api_key", provider: "openai", key: "fixture-personal-key" },
      assertCurrent() {},
    }));
    await measure("before-reload");
    const before = await gateway.client.request<{ hash: string }>("config.get", {});
    await gateway.client.request("config.patch", {
      baseHash: before.hash,
      raw: JSON.stringify({ agents: { defaults: { model: { primary: "openai/model-1" } } } }),
    });
    expect(getRuntimeConfig().agents?.defaults?.model).toEqual({ primary: "openai/model-1" });
    const afterLoads = await measure("after-reload");
    expect(afterLoads).toBe(0);
  } finally {
    resolvePolicy.mockRestore();
    candidateLoader.mockRestore();
    listHandler.mockRestore();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "policy reload proof complete" });
    vi.unstubAllEnvs();
  }
}, 120_000);
