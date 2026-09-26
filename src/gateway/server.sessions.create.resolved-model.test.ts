import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
} from "./agent-runtime-identity-token.js";
import type { GatewayClient } from "./server-methods/types.js";
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

test("new unpinned sessions bind the account for the permitted operator default", async () => {
  const { storePath } = await createSessionStoreDir();
  const owner = ensureProfileForEmail("role-default-account@example.test");
  const accounts = new Map(
    ["primary", "permitted"].map((provider) => [
      provider,
      connectUserModelAccount({
        ownerProfileId: owner.id,
        credential: { type: "token", provider, token: `synthetic-${provider}-account` },
        assertCurrent() {},
      }).authProfileId,
    ]),
  );
  const base = (await getGatewayConfigModule()).getRuntimeConfig();
  const model: ModelDefinitionConfig = {
    id: "model",
    name: "Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
  const cfg: OpenClawConfig = {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        model: { primary: "primary/model", fallbacks: ["permitted/model"] },
      },
    },
    models: {
      providers: Object.fromEntries(
        ["primary", "permitted"].map((provider) => [
          provider,
          {
            api: "openai-completions" as const,
            baseUrl: `https://${provider}.invalid/v1`,
            agentRuntime: { id: "openclaw" },
            models: [model],
          },
        ]),
      ),
    },
  };
  const client: GatewayClient = {
    connId: "role-default-account",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.write"],
    },
    authenticatedUserProfile: {
      profileId: owner.id,
      displayName: owner.displayName,
      hasAvatar: false,
      updatedAt: owner.updatedAt,
    },
    internal: {
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: owner.id,
        scopes: ["operator.write"],
        assertCurrent: () => {},
        modelPolicy: prepareOperatorModelPolicy({ cfg, policy: { deny: ["primary/model"] } }),
      }),
    },
  };
  const key = "agent:main:dashboard:role-default-account";
  const created = await directSessionReq(
    "sessions.create",
    { key, agentId: "main" },
    {
      client,
      context: {
        getRuntimeConfig: () => cfg,
        getCommittedRuntimeConfig: () => cfg,
        getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
          new Set(!filter || filter(client) ? [client.connId!] : []),
      },
    },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
  expect(entry).toMatchObject({
    authProfileOverride: expectDefined(accounts.get("permitted"), "permitted account"),
    authProfileOverrideSource: "user-link",
  });
  expect(entry?.modelOverride).toBeUndefined();
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
  { mode: "role-denied", model: "middle", expected: undefined },
  { mode: "role-allowed", model: "middle", expected: "middle" },
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
  if (mode === "role-denied" || mode === "role-allowed") {
    client.internal = {
      ...client.internal,
      operatorRunAuthority: createAdmittedRunOperatorAuthority({
        profileId: "limited-operator",
        scopes: ["operator.write"],
        assertCurrent: () => {},
        modelPolicy: prepareOperatorModelPolicy({
          cfg,
          policy: { allow: [mode === "role-allowed" ? "custom/middle" : "custom/default"] },
        }),
      }),
    };
  }
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
          : mode === "role-denied"
            ? {
                ok: false,
                error: {
                  code: "FORBIDDEN",
                  message: expect.stringContaining("operator role cannot use this model"),
                },
              }
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
