import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import levanto from "../extensions/levanto/index.js";
import * as modelAuthProvider from "../src/agents/model-auth-provider.js";
import { acquireAgentRunPreparedModelRuntime } from "../src/agents/prepared-model-runtime.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { DecisionContractError } from "../src/decisions/contract-error.js";
import { prepareDecisionProviderReload } from "../src/decisions/provider-reload.js";
import { evaluateDecisionV2InRegistry } from "../src/decisions/runtime.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../src/infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../src/infra/diagnostic-otel-listener-provenance.js";
import { getImageMetadata } from "../src/media/media-services.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import {
  admissionPlugin,
  createAdmissionBarrier,
  resetAdmissionState,
  withAdmissionFixture,
  type AdmissionFixture,
} from "./decision-admission.test-support.js";

const changes = ["allowed", "revoked", "replaced", "image-allowed", "box-unsupported"] as const;
const agentId = "decision-agent";
const profileId = "levanto:fixture";
it.each(changes)(
  "checks the registered Sage capability and credential owner before final HTTP (%s)",
  (change) =>
    withAdmissionFixture(
      "levanto",
      {
        id: "q",
        kind: "yesno",
        result: { answer: "yes", probability: 0.9 },
        meta: { model: "levanto-sage", usage: { input_tokens: 5, output_tokens: 1 } },
      },
      (fixture) => runScenario(change, fixture),
    ),
);

async function runScenario(
  change: (typeof changes)[number],
  { state, baseUrl, received }: AdmissionFixture,
) {
  const cfg = levantoConfig(state);
  await state.writeAuthProfiles(
    {
      version: 1,
      profiles: {
        [profileId]: { type: "api_key", provider: "levanto", key: "synthetic-sage-key" },
      },
    },
    agentId,
  );
  const agentDir = state.agentDir(agentId);
  setRuntimeConfigSnapshot(cfg);
  const { metadata, record } = admissionPlugin("levanto", cfg, state.workspaceDir);
  const builder = createTestPluginRegistry(
    createPluginRuntimeMock({ config: { current: () => cfg }, media: { getImageMetadata } }),
  );
  const api = builder.createApi(record, { config: cfg });
  runPluginRegisterSyncInRegistry(levanto.register, api, builder.registry, record.id);
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  try {
    // Keep the actual source identity and prepared auth/catalog owner;
    // Vitest imports only make the forwarding DNS barrier observable.
    await using prepared = await acquireAgentRunPreparedModelRuntime(
      {
        config: cfg,
        agentId,
        agentDir,
        workspaceDir: state.workspaceDir,
        loadRuntimePlugins: true,
        runtimePluginPurpose: "isolated-completion",
        runtimePluginSelections: [{ provider: "levanto", modelId: "levanto-sage", agentId }],
      },
      { catalogMode: "static", pluginMetadataSnapshot: metadata },
    );
    expect(prepared.snapshot.isCurrent()).toBe(true);
    const controller = new AbortController();
    const supported = change === "allowed" || change === "image-allowed";
    const auth = vi.spyOn(modelAuthProvider, "resolveApiKeyForProviderCore");
    const barrier = createAdmissionBarrier("https://sage.levanto.ai/decide", {
      url: baseUrl + "/decide",
      lookupFn: (hostname, options) => dns.lookup(hostname, options),
    });
    const { release, forwarding } = barrier;
    const input: DecisionBatchV2 = {
      state:
        change === "image-allowed" || change === "box-unsupported"
          ? {
              type: "image",
              dataUri:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAK0lEQVR4nO3OIQEAAAwEoetfeovxBoGnq1tKQEBAQEBAQEBAQEBAQEBgHXhUDfhqRFDd3gAAAABJRU5ErkJggg==",
            }
          : { type: "text", text: "synthetic evidence" },
      questions: {
        q:
          change === "box-unsupported"
            ? { type: "box", instructions: "the red square" }
            : { type: "boolean", instructions: "Needs review?" },
      },
    };
    const pending = evaluateDecisionV2InRegistry(
      input,
      {
        agentId,
        purpose: "owner-proof",
        rubricVersion: "1",
        timeoutMs: 5000,
        signal: controller.signal,
      },
      builder.registry,
      cfg,
    );
    const settled = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      if (change === "box-unsupported") {
        await expect(pending).resolves.toMatchObject({
          status: "unavailable",
          reason: "unsupported-input",
        });
        for (const spy of [auth, forwarding]) {
          expect(spy).not.toHaveBeenCalled();
        }
        expect(received).toHaveLength(0);
        return;
      }
      await barrier.wait(settled);
      expect(auth).toHaveBeenCalledOnce();
      expect(received).toHaveLength(0);
      if (change === "revoked" || change === "replaced") {
        // Test workers persist through the fixture owner, not host-only agent admission.
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles:
              change === "revoked"
                ? {}
                : {
                    [profileId]: {
                      type: "api_key",
                      provider: "levanto",
                      key: "synthetic-replacement",
                    },
                  },
          },
          agentId,
        );
      }
      release.resolve();
      const outcome = await settled;
      expect(barrier.admission).toBe(supported ? "allowed" : "rejected");
      expect(received).toHaveLength(supported ? 1 : 0);
      if (supported) {
        expect(outcome).toMatchObject({
          result: {
            status: "ok",
            result: {
              answers: { q: { type: "boolean", answer: true, probabilityTrue: 0.9 } },
              usage: { inputTokens: 5, outputTokens: 1 },
            },
          },
        });
        expect(received[0]).toMatchObject({
          url: "/decide",
          authorization: "Bearer synthetic-sage-key",
        });
        expect(received[0]?.body).not.toHaveProperty("grounding");
      } else {
        expect(outcome).toMatchObject({ error: new DecisionContractError() });
      }
    } finally {
      release.resolve();
      controller.abort();
      await settled;
      for (const spy of [forwarding, auth]) {
        spy.mockRestore();
      }
    }
  } finally {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
    await resetAdmissionState(true);
  }
}

function levantoConfig(state: AdmissionFixture["state"]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "unrelated/not-configured",
        decisionModel: `levanto/levanto-sage@${profileId}`,
        workspace: state.workspaceDir,
      },
      entries: { [agentId]: {} },
    },
    models: {
      providers: {
        levanto: {
          baseUrl: "https://sage.levanto.ai",
          models: [],
          request: { allowPrivateNetwork: true },
        },
      },
    },
    plugins: {
      load: { paths: [fileURLToPath(new URL("../extensions/levanto", import.meta.url))] },
      slots: { memory: "none" },
      entries: { levanto: { enabled: true } },
    },
  };
}

it("completes native Sage usage once and rejects a retired plugin consumer", async () => {
  const secondRequest = createDeferredCore();
  const allowResponse = createDeferredCore();
  await withAdmissionFixture(
    "levanto",
    {
      id: "q",
      kind: "yesno",
      result: { answer: "yes", probability: 0.9 },
      meta: { model: "synthetic-sage-backend", usage: { input_tokens: 5, output_tokens: 1 } },
    },
    async ({ state, baseUrl, received }) => {
      const cfg = levantoConfig(state);
      cfg.diagnostics = { enabled: true };
      cfg.plugins = {
        ...cfg.plugins,
        entries: { ...cfg.plugins?.entries, "decision-consumer": { enabled: true } },
      };
      await state.writeAuthProfiles(
        {
          version: 1,
          profiles: {
            [profileId]: { type: "api_key", provider: "levanto", key: "synthetic-sage-key" },
          },
        },
        agentId,
      );
      setRuntimeConfigSnapshot(cfg);
      const { metadata, record } = admissionPlugin("levanto", cfg, state.workspaceDir);
      const builder = createTestPluginRegistry(
        createPluginRuntimeMock({ config: { current: () => cfg }, media: { getImageMetadata } }),
      );
      const providerApi = builder.createApi(record, { config: cfg });
      runPluginRegisterSyncInRegistry(levanto.register, providerApi, builder.registry, record.id);
      builder.registry.plugins.push(record);
      const consumer = createPluginRecord({
        id: "decision-consumer",
        source: state.path("consumer.ts"),
        origin: "global",
        enabled: true,
        configSchema: false,
      });
      const api = builder.createApi(consumer, { config: cfg });
      runPluginRegisterSyncInRegistry(() => {}, api, builder.registry, consumer.id);
      builder.registry.plugins.push(consumer);
      setActivePluginRegistry(builder.registry);
      const events: Array<{
        event: Extract<DiagnosticEventPayload, { type: "model.usage" }>;
        hostPluginId: unknown;
        trusted: boolean;
      }> = [];
      const stop = onTrustedInternalDiagnosticEvent(
        markTrustedOtelDiagnosticListener((event, provenance, privateData) => {
          if (event.type === "model.usage") {
            events.push({
              event,
              hostPluginId: Reflect.get(privateData, "hostPluginId"),
              trusted: provenance.trusted,
            });
          }
        }),
      );
      const barrier = createAdmissionBarrier("https://sage.levanto.ai/decide", {
        url: baseUrl + "/decide",
        lookupFn: (hostname, options) => dns.lookup(hostname, options),
      });
      barrier.release.resolve();
      const controller = new AbortController();
      let pending: Promise<unknown> | undefined;
      let disposal:
        | ReturnType<NonNullable<ReturnType<typeof getPluginInstance>>["dispose"]>
        | undefined;
      try {
        await using prepared = await acquireAgentRunPreparedModelRuntime(
          {
            config: cfg,
            agentId,
            agentDir: state.agentDir(agentId),
            workspaceDir: state.workspaceDir,
            loadRuntimePlugins: true,
            runtimePluginPurpose: "isolated-completion",
            runtimePluginSelections: [{ provider: "levanto", modelId: "levanto-sage", agentId }],
          },
          { catalogMode: "static", pluginMetadataSnapshot: metadata },
        );
        expect(prepared.snapshot.isCurrent()).toBe(true);
        const input: DecisionBatchV2 = {
          state: { type: "text", text: "synthetic evidence" },
          questions: { q: { type: "boolean" } },
        };
        const evaluate = () =>
          api.runtime.decisions.evaluateV2(input, {
            agentId,
            purpose: "consumer-proof",
            rubricVersion: "1",
            timeoutMs: 5000,
            signal: controller.signal,
          });
        try {
          const accepted = await evaluate();
          expect(accepted).toMatchObject({
            status: "ok",
            result: {
              model: "synthetic-sage-backend",
              answers: { q: { type: "boolean", answer: true, probabilityTrue: 0.9 } },
              usage: { inputTokens: 5, outputTokens: 1 },
            },
          });
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            trusted: true,
            hostPluginId: consumer.id,
            event: {
              type: "model.usage",
              provider: "levanto",
              model: "levanto-sage",
              agentId,
              usage: { input: 5, output: 1 },
            },
          });
          expect(events[0]?.event).not.toHaveProperty("costUsd");
          expect(events[0]?.event).not.toHaveProperty("sessionKey");
          pending = evaluate();
          const outcome = pending.then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          await Promise.race([
            secondRequest.promise,
            outcome.then((value) => {
              throw new Error("Consumer settled before second native HTTP request", {
                cause: value,
              });
            }),
          ]);
          expect(received).toHaveLength(2);
          expect(builder.registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(1);
          const instance = getPluginInstance(consumer);
          assert(instance);
          disposal = instance.dispose();
          expect(instance.acceptingCalls).toBe(false);
          allowResponse.resolve();
          const rejected = await outcome;
          expect(rejected).toHaveProperty("error");
          expect(await disposal).toEqual({ errors: [] });
          expect(events).toHaveLength(1);
          expect(builder.registry.decisionProviders[0]?.host.inspect(cfg).activeRequests).toBe(0);
          expect(getPluginInstance(record)?.acceptingCalls).toBe(true);
        } finally {
          allowResponse.resolve();
          controller.abort();
          await pending?.catch(() => undefined);
          await disposal;
        }
      } finally {
        stop();
        barrier.forwarding.mockRestore();
        prepareDecisionProviderReload(builder.registry, new Set([record.id]));
        await getPluginInstance(consumer)?.dispose();
        await getPluginInstance(record)?.dispose();
        await resetAdmissionState(true);
      }
    },
    async (requestNumber) => {
      if (requestNumber === 2) {
        secondRequest.resolve();
        await allowResponse.promise;
      }
    },
  );
});
