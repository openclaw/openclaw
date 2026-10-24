import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import levanto from "../extensions/levanto/index.js";
import { removeAuthProfilesAcrossOwnerStores } from "../src/agents/auth-profiles/profiles.js";
import { upsertAuthProfileWithLockOrThrow } from "../src/agents/auth-profiles/upsert-with-lock.js";
import * as modelAuthProvider from "../src/agents/model-auth-provider.js";
import { acquireAgentRunPreparedModelRuntime } from "../src/agents/prepared-model-runtime.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  evaluateDecisionV2InRegistry,
  prepareDecisionProviderReload,
} from "../src/decisions/runtime.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";
import { DecisionContractError } from "../src/decisions/validation.js";
import { getImageMetadata } from "../src/media/media-services.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
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
  const cfg: OpenClawConfig = {
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
    createPluginRuntimeMock({ config: { current: () => cfg } }),
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
    expect(prepared.snapshot.pluginRegistry?.providers).toContainEqual(
      expect.objectContaining({ pluginId: record.id, source: record.source }),
    );
    expect(prepared.snapshot.modelCatalog.entries).toContainEqual(
      expect.objectContaining({ provider: "levanto", id: "levanto-sage" }),
    );
    const controller = new AbortController();
    const supported = change === "allowed" || change === "image-allowed";
    const auth = vi.spyOn(modelAuthProvider, "resolveApiKeyForProviderCore");
    const probe = vi
      .spyOn(api.runtime.media, "getImageMetadata")
      .mockImplementation(getImageMetadata);
    const registered = builder.registry.decisionProviders[0]?.host.provider;
    assert(registered?.contractVersion === 2);
    const adapter = vi.spyOn(registered, "evaluate");
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
        for (const spy of [auth, adapter, probe, forwarding]) {
          expect(spy).not.toHaveBeenCalled();
        }
        expect(received).toHaveLength(0);
        return;
      }
      await barrier.wait(settled);
      expect(auth).toHaveBeenCalledOnce();
      expect(adapter).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledTimes(change === "image-allowed" ? 1 : 0);
      expect(received).toHaveLength(0);
      expect(prepared.snapshot.isCurrent()).toBe(true);
      if (change === "revoked") {
        expect(
          await removeAuthProfilesAcrossOwnerStores({
            cfg,
            agentDir,
            provider: "levanto",
            profileIds: [profileId],
          }),
        ).toBe(true);
      } else if (change === "replaced") {
        await upsertAuthProfileWithLockOrThrow({
          profileId,
          agentDir,
          credential: {
            type: "api_key",
            provider: "levanto",
            key: "synthetic-replacement",
          },
        });
      }
      expect(prepared.snapshot.isCurrent()).toBe(supported);
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
      for (const spy of [forwarding, adapter, probe, auth]) {
        spy.mockRestore();
      }
    }
  } finally {
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
    await resetAdmissionState(true);
  }
}
