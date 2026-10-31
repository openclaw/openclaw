import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import subq from "../extensions/subq/index.js";
import { createAdmittedRunOperatorAuthority } from "../src/agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../src/agents/operator-model-policy.js";
import { parseDecisionEvaluateInput } from "../src/agents/tools/decision-tool-contract.js";
import { createDecisionTool } from "../src/agents/tools/decision-tool.js";
import { withGatewayToolCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { resolveConfigWidePluginManifestRegistry } from "../src/config/io.plugin-metadata.js";
import { getRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  evaluateDecisionInRegistry,
  prepareDecisionProviderReload,
} from "../src/decisions/runtime.js";
import type { DecisionBatch } from "../src/decisions/types.js";
import { validateDecisionResultV2 } from "../src/decisions/validation-v2.js";
import { fetchWithRuntimeDispatcher } from "../src/infra/net/runtime-fetch.js";
import { createHttp1Agent } from "../src/infra/net/undici-runtime.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createRuntimeTestRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../src/secrets/runtime.js";
import {
  admissionPlugin,
  createAdmissionBarrier,
  resetAdmissionState,
  withAdmissionFixture,
  type AdmissionFixture,
} from "./decision-admission.test-support.js";

const batch: DecisionBatch = {
  state: "Service is down",
  questions: {
    urgent: { type: "boolean" },
    route: { type: "choice", criteria: { support: "Service failures", sales: null } },
    impact: { type: "score", criteria: ["Low", "High"] },
  },
};
const nativeUrl = "https://api.subq.ai/v1/systemone";

const changes = [
  "allowed",
  "model-denied",
  "consumer-revoked",
  "core-allowed",
  "secret-replaced",
  "secret-removed",
] as const;

it.each(changes)(
  "checks the real SubQ host authority and final network dispatch after DNS preparation (%s)",
  (change) =>
    withAdmissionFixture(
      "subq",
      {
        model: "subq-snap-preview",
        answers: {
          urgent: { type: "noul", noul: 0.9 },
          route: { type: "choice", choice: "support", probabilities: { support: 0.8, sales: 0.2 } },
          impact: {
            type: "score",
            score: 0.6,
            probabilities: { "0": 0.4, "1": 0.6 },
            legend: { "0": "Low", "1": "High" },
          },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      },
      (fixture) => runScenario(change, fixture),
    ),
);

async function runScenario(
  change: (typeof changes)[number],
  { state, baseUrl, received }: AdmissionFixture,
) {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { decisionModel: "subq/subq-snap-preview", workspace: state.workspaceDir },
      entries: { main: {} },
    },
    plugins: {
      load: { paths: [fileURLToPath(new URL("../extensions/subq", import.meta.url))] },
      slots: { memory: "none" },
      entries: {
        subq: {
          enabled: true,
          config: { apiKey: { source: "env", provider: "default", id: "SUBQ_API_KEY" } },
        },
        consumer: { enabled: true },
      },
    },
  };
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  let disposal:
    | ReturnType<NonNullable<ReturnType<typeof getPluginInstance>>["dispose"]>
    | undefined;
  let builder: ReturnType<typeof createRuntimeTestRegistry> | undefined;
  let provider: ReturnType<typeof createPluginRecord> | undefined;
  let consumer: ReturnType<typeof createPluginRecord> | undefined;
  let dispatcher: ReturnType<typeof createHttp1Agent> | undefined;
  let barrier: ReturnType<typeof createAdmissionBarrier> | undefined;
  try {
    const { metadata, manifest, record } = admissionPlugin("subq", cfg, state.workspaceDir);
    const prepareSnapshot = (env: NodeJS.ProcessEnv) =>
      prepareSecretsRuntimeSnapshot({
        config: cfg,
        env,
        includeConfigRefs: true,
        includeAuthStoreRefs: false,
        manifestRegistry: resolveConfigWidePluginManifestRegistry({
          config: cfg,
          env: process.env,
        }),
      });
    activateSecretsRuntimeSnapshot(await prepareSnapshot(process.env));
    const secretRevision = getActiveSecretsRuntimeSnapshotRevision();
    const runtimeConfig = getRuntimeConfigSnapshot();
    assert(runtimeConfig);
    builder = createRuntimeTestRegistry(createPluginRuntime());
    provider = record;
    const providerApi = builder.createApi(provider, { config: cfg });
    runPluginRegisterSyncInRegistry(subq.register, providerApi, builder.registry, provider.id);
    consumer = createPluginRecord({
      id: "consumer",
      source: state.path("consumer.ts"),
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const consumerApi = builder.createApi(consumer, { config: cfg });
    runPluginRegisterSyncInRegistry(() => {}, consumerApi, builder.registry, consumer.id);
    setActivePluginRegistry(builder.registry);
    const loopbackDispatcher = createHttp1Agent();
    dispatcher = loopbackDispatcher;
    barrier = createAdmissionBarrier(
      nativeUrl,
      {
        url: nativeUrl,
        expectedHostname: "api.subq.ai",
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: (url, init) => {
          expect(url).toBe(nativeUrl);
          // Never reuse the native-host pinned dispatcher for loopback.
          return fetchWithRuntimeDispatcher(baseUrl + "/systemone", {
            ...init,
            dispatcher: loopbackDispatcher,
          });
        },
      },
      true,
    );
    expect(manifest.rootDir).toBe(fileURLToPath(new URL("../extensions/subq", import.meta.url)));
    expect(provider.source).toBe(manifest.source);
    expect(
      builder.registry.decisionProviders.map((entry) => entry.host.inspect(cfg)),
    ).toContainEqual(
      expect.objectContaining({ providerId: "subq", callable: true, credentialReady: true }),
    );
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "decision-reader",
      scopes: ["operator.write"],
      assertCurrent() {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg,
        policy: {
          sourceAgent: "main",
          allow: ["subq/*"],
          deny: change === "model-denied" ? ["subq/subq-snap-preview"] : [],
        },
        manifestPlugins: metadata,
      }),
    });
    const tool = createDecisionTool("main", { config: cfg });
    assert(tool);
    const invoke: () => Promise<unknown> = () => {
      const options = {
        purpose: "owner-proof",
        rubricVersion: "1",
        timeoutMs: 5000,
        signal: controller.signal,
      };
      if (
        change === "core-allowed" ||
        change === "secret-replaced" ||
        change === "secret-removed"
      ) {
        // No caller predicate: the V1 host itself must fence changed secrets
        // after DNS preparation, before the adapter's physical request.
        return evaluateDecisionInRegistry(batch, options, builder!.registry, runtimeConfig);
      }
      return change === "consumer-revoked"
        ? consumerApi.runtime.decisions.evaluate(batch, options)
        : tool.execute("owner-proof", batch, controller.signal);
    };
    pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:fixture",
        operatorAuthority: authority,
      },
      invoke,
    );
    const settled = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if (change === "model-denied") {
      await expect(pending).rejects.toThrow("cannot use this model");
      expect(barrier.forwarding).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
    } else {
      await barrier.wait(settled);
      expect(received).toHaveLength(0);
      expect(getActiveSecretsRuntimeSnapshotRevision()).toBe(secretRevision);
      if (change === "consumer-revoked") {
        const instance = getPluginInstance(consumer);
        assert(instance);
        disposal = instance.dispose();
        expect(instance.disposing).toBe(true);
        expect(instance.acceptingCalls).toBe(false);
        expect(instance.owner?.revoked).toBe(true);
      } else if (change === "secret-replaced") {
        activateSecretsRuntimeSnapshot(
          await prepareSnapshot({
            ...process.env,
            SUBQ_API_KEY: "synthetic-subq-replacement",
          }),
        );
        expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(secretRevision);
      } else if (change === "secret-removed") {
        clearSecretsRuntimeSnapshot();
        expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(secretRevision);
      }
      expect(controller.signal.aborted).toBe(false);
      barrier.release.resolve();
      const outcome = await settled;
      const allowed = change === "allowed" || change === "core-allowed";
      expect(received).toHaveLength(allowed ? 1 : 0);
      expect(barrier.admission).toBe(allowed ? "allowed" : "rejected");
      if (change === "allowed") {
        assert("result" in outcome);
        const result = outcome.result as Awaited<ReturnType<typeof tool.execute>>;
        const text = result.content[0];
        assert(text?.type === "text");
        const visible = JSON.parse(text.text);
        const parsed = parseDecisionEvaluateInput(batch);
        assert(parsed);
        expect(visible.status).toBe("ok");
        expect(validateDecisionResultV2(parsed, visible.result)).toBe(true);
        expect(visible.result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
        expect(received[0]).toMatchObject({
          method: "POST",
          authorization: "Bearer synthetic-subq-key",
          body: {
            model: "subq-snap-preview",
            questions: { urgent: { type: "noul" } },
          },
        });
      } else if (change === "core-allowed") {
        expect(outcome).toMatchObject({
          result: {
            status: "ok",
            result: { answers: { urgent: { type: "boolean" } } },
          },
        });
        expect(received[0]?.authorization).toBe("Bearer synthetic-subq-key");
      } else if (change === "consumer-revoked") {
        expect(outcome).toHaveProperty("error");
        expect(await disposal).toEqual({ errors: [] });
      } else {
        expect(outcome).toEqual({
          result: { status: "unavailable", reason: "retiring" },
        });
      }
    }
    expect(builder.registry.decisionProviders[0]!.host.inspect(cfg)).toMatchObject({
      callable: change !== "secret-removed",
      credentialReady: change !== "secret-removed",
      activeRequests: 0,
    });
  } finally {
    barrier?.release.resolve();
    controller.abort();
    await pending?.catch(() => undefined);
    await disposal;
    barrier?.forwarding.mockRestore();
    if (consumer) {
      await getPluginInstance(consumer)?.dispose();
    }
    if (builder && provider) {
      prepareDecisionProviderReload(builder.registry, new Set([provider.id]));
      await getPluginInstance(provider)?.dispose();
    }
    await dispatcher?.close();
    clearSecretsRuntimeSnapshot();
    await resetAdmissionState();
  }
}
