import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "./agent-runtime-identity-token.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "model-identity-fixture",
      providers: ["custom"],
      modelIdNormalization: { providers: { custom: { aliases: { middle: "final" } } } },
    },
  ],
});

test.each([
  { mode: "public", model: "middle", expected: "final" },
  { mode: "in-process", model: "middle", expected: "middle" },
  { mode: "signed", model: "middle", expected: "middle" },
  { mode: "in-process", model: "custom/model", expected: "custom/model" },
  { mode: "disallowed", model: "middle", expected: undefined },
  { mode: "revoked", model: "middle", expected: undefined },
  { mode: "mismatched", model: "middle", expected: undefined },
  { mode: "public-spoof", model: "middle", expected: undefined },
])("sessions.create consumes $mode model $model", async ({ mode, model, expected }) => {
  const { storePath } = await createSessionStoreDir();
  const baseConfig = (await getGatewayConfigModule()).getRuntimeConfig();
  const models = ["default", "middle", "final", "custom/model"].map(
    (id) =>
      ({
        id,
        name: id,
        provider: "custom",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 1024,
      }) satisfies ModelDefinitionConfig & { provider: string },
  );
  const cfg: OpenClawConfig = {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        model: "custom/default",
        ...(mode === "disallowed" ? { modelPolicy: { allow: ["custom/final"] } } : {}),
      },
    },
    models: {
      providers: {
        custom: { api: "openai-responses", baseUrl: "https://custom.example/v1", models },
      },
    },
  };
  const parentSessionKey = "agent:main:main";
  const childSessionKey = `agent:main:dashboard:resolved-${mode}-${model.replaceAll("/", "-")}`;
  await writeSessionStore({ entries: { [parentSessionKey]: sessionStoreEntry("model-parent") } });
  const operationalRunInstance = createOperationalRunInstanceRef(`model-parent-${mode}`);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const resolvedModel = { provider: "custom", model };
  const spawnContext = {
    inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] },
    resolvedModel,
    spawnModelAutoSelection: { model: `custom/${model}`, hasFallbackOrigin: true },
  };
  const creation = {
    via: "spawn" as const,
    actor: { type: "agent" as const, id: "main" },
    requesterSessionKey: parentSessionKey,
    ...spawnContext,
  };
  let requesterActive = true;
  const client = createSyntheticPluginRuntimeClient({
    scopes: ["operator.write"],
    operatorRoleActor: { kind: "system" },
    ...(mode !== "public" && mode !== "public-spoof" && mode !== "signed"
      ? {
          sessionCreation: creation,
          agentToolCaller: {
            agentId: "main",
            sessionKey: parentSessionKey,
            assertCurrent: () => {
              if (!requesterActive) {
                throw new Error("spawn requester is no longer active");
              }
            },
          },
        }
      : {}),
  });
  try {
    if (mode === "signed") {
      const token = await mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: parentSessionKey,
        operationalRunInstance,
        sessionSpawnContext: spawnContext,
      });
      const identity = expectDefined(
        await verifyAgentRuntimeIdentityToken(token),
        "verified spawn identity",
      );
      client.internal = { ...client.internal, agentRuntimeIdentity: identity };
    }
    const request = withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      directSessionReq(
        "sessions.create",
        {
          key: childSessionKey,
          agentId: "main",
          parentSessionKey,
          spawnDepth: 1,
          model: mode === "mismatched" ? "custom/final" : `custom/${model}`,
          ...(mode === "public-spoof" ? { resolvedModel } : {}),
        },
        {
          client,
          context: {
            getRuntimeConfig: () => cfg,
            loadGatewayModelCatalogSnapshot: async () => {
              if (mode === "revoked") {
                requesterActive = false;
              }
              return { entries: models, routeVariants: models };
            },
            validateAgentRuntimeApprovalAuthority: () => requesterActive,
          },
        },
      ),
    );
    if (mode === "revoked" || mode === "mismatched") {
      await expect(request).rejects.toThrow(
        mode === "revoked"
          ? "spawn requester is no longer active"
          : "Resolved spawn model does not match the requested model",
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath }),
      ).toBeUndefined();
      return;
    }
    const result = await request;
    const entry = loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath });
    if (expected === undefined) {
      expect(result).toMatchObject(
        mode === "public-spoof"
          ? { ok: false, error: { code: "INVALID_REQUEST" } }
          : { ok: false, error: { message: expect.stringContaining("model not allowed") } },
      );
      expect(entry).toBeUndefined();
    } else {
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(entry).toMatchObject({
        providerOverride: "custom",
        modelOverride: expected,
        modelOverrideRouteResolution: "resolved",
        modelOverrideSource: mode === "public" ? "user" : "auto",
        ...(mode !== "public"
          ? {
              modelOverrideFallbackOriginProvider: "custom",
              modelOverrideFallbackOriginModel: expected,
            }
          : {}),
      });
    }
  } finally {
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
  }
});
