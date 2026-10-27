import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import * as admittedRuns from "../agents/admitted-run-context.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as runs from "../infra/agent-run-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import * as runtimeIdentity from "./agent-runtime-identity-token.js";
import { createSessionMutationTestClient } from "./server-methods/sessions-mutations.owner.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import * as sessions from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = sessions.setupGatewaySessionsHandlerTestHarness();
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "model-identity-fixture",
      providers: ["custom"],
      modelIdNormalization: { providers: { custom: { aliases: { middle: "final" } } } },
    },
  ],
});

const makeModel = (id: string) => modelDefinition(id, { reasoning: false, maxTokens: 1024 });
async function modelConfig(
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
  providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>,
): Promise<OpenClawConfig> {
  const base = (await sessions.getGatewayConfigModule()).getRuntimeConfig();
  return {
    ...base,
    agents: { ...base.agents, defaults: { ...base.agents?.defaults, ...defaults } },
    models: { providers },
  };
}
const operatorAuthority = (
  cfg: OpenClawConfig,
  profileId: string,
  policy: Parameters<typeof prepareOperatorModelPolicy>[0]["policy"],
) =>
  admittedRuns.createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.write"],
    assertCurrent: () => {},
    modelPolicy: prepareOperatorModelPolicy({ cfg, policy }),
  });

test("new unpinned sessions bind the account for the permitted operator default", async () => {
  const { storePath } = await createSessionStoreDir();
  const owner = ensureProfileForEmail("role-default-account@example.test");
  const accounts = ["primary", "permitted"].map(
    (provider) =>
      connectUserModelAccount({
        ownerProfileId: owner.id,
        credential: { type: "token", provider, token: `synthetic-${provider}-account` },
        assertCurrent() {},
      }).authProfileId,
  );
  const cfg = await modelConfig(
    { model: { primary: "primary/model", fallbacks: ["permitted/model"] } },
    Object.fromEntries(
      ["primary", "permitted"].map((provider) => [
        provider,
        {
          api: "openai-completions" as const,
          baseUrl: `https://${provider}.invalid/v1`,
          agentRuntime: { id: "openclaw" },
          models: [makeModel("model")],
        },
      ]),
    ),
  );
  const client: GatewayClient = {
    ...createSessionMutationTestClient(),
    connId: "role-default-account",
    authenticatedUserProfile: gatewayProfile(owner.id, owner.displayName, owner.updatedAt),
    internal: {
      operatorRunAuthority: operatorAuthority(cfg, owner.id, { deny: ["primary/model"] }),
    },
  };
  const key = "agent:main:dashboard:role-default-account";
  const created = await sessions.directSessionReq(
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
    authProfileOverride: expectDefined(accounts[1], "permitted account"),
    authProfileOverrideSource: "user-link",
  });
  expect(entry?.modelOverride).toBeUndefined();
});

test.each([
  { mode: "public", model: "default", expected: "default" },
  { mode: "public", model: "middle", expected: "final" },
  { mode: "in-process", model: "middle", expected: "middle" },
  { mode: "signed", model: "middle", expected: "middle" },
  { mode: "disallowed", model: "middle", expected: undefined },
  { mode: "revoked", model: "middle", expected: undefined },
  { mode: "mismatched", model: "middle", expected: undefined },
  { mode: "public-spoof", model: "middle", expected: undefined },
  { mode: "role-denied", model: "middle", expected: undefined },
  { mode: "role-allowed", model: "middle", expected: "middle" },
])("sessions.create consumes $mode model $model", async ({ mode, model, expected }) => {
  const { storePath } = await createSessionStoreDir();
  const models = ["default", "middle", "final"].map((id) =>
    Object.assign(makeModel(id), { provider: "custom" }),
  );
  const cfg = await modelConfig(
    {
      model: "custom/default",
      ...(mode === "disallowed" ? { modelPolicy: { allow: ["custom/final"] } } : {}),
    },
    { custom: { api: "openai-responses", baseUrl: "https://custom.example/v1", models } },
  );
  const parentSessionKey = "agent:main:main";
  const childSessionKey = `agent:main:dashboard:resolved-${mode}-${model.replaceAll("/", "-")}`;
  const readEntry = () =>
    loadSessionEntry({ agentId: "main", sessionKey: childSessionKey, storePath });
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessions.sessionStoreEntry("model-parent", {
        lifecycleRevision: "parent-generation",
      }),
    },
  });
  const operationalRunInstance = admittedRuns.createOperationalRunInstanceRef(
    `model-parent-${mode}`,
  );
  const delegatedAuthority = runs.claimAgentRunDelegatedAuthority(operationalRunInstance);
  const resolvedModel = { provider: "custom", model };
  const spawnContext = {
    requesterSenderIsOwner: mode === "in-process",
    inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] },
    resolvedModel,
    spawnModelAutoSelection: { model: `custom/${model}`, hasFallbackOrigin: true },
  };
  let requesterActive = true;
  const client = createSyntheticPluginRuntimeClient({
    scopes: ["operator.write"],
    operatorRoleActor: { kind: "system" },
    ...(mode !== "public" && mode !== "public-spoof" && mode !== "signed"
      ? {
          sessionCreation: {
            via: "spawn",
            actor: { type: "agent", id: "main" },
            requesterSessionKey: parentSessionKey,
            ...spawnContext,
          },
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
      operatorRunAuthority: operatorAuthority(cfg, "limited-operator", {
        allow: [mode === "role-allowed" ? "custom/middle" : "custom/default"],
      }),
    };
  }
  try {
    if (mode === "signed") {
      const token = await runtimeIdentity.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: parentSessionKey,
        operationalRunInstance,
        sessionSpawnContext: spawnContext,
      });
      const identity = expectDefined(
        await runtimeIdentity.verifyAgentRuntimeIdentityToken(token),
        "verified spawn identity",
      );
      client.internal = { ...client.internal, agentRuntimeIdentity: identity };
    }
    const request = withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      sessions.directSessionReq(
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
      expect(readEntry()).toBeUndefined();
      return;
    }
    const result = await request;
    const entry = readEntry();
    if (expected === undefined) {
      expect(result.ok).toBe(false);
      if (mode === "public-spoof" || mode === "role-denied") {
        expect(result.error?.code).toBe(mode === "public-spoof" ? "INVALID_REQUEST" : "FORBIDDEN");
      }
      if (mode !== "public-spoof") {
        expect(result.error?.message).toContain(
          mode === "role-denied" ? "operator role cannot use this model" : "model not allowed",
        );
      }
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
              spawnedBy: parentSessionKey,
              parentSessionId: "model-parent",
              spawnedBySessionId: "model-parent",
              parentSessionLifecycleRevision: "parent-generation",
              spawnedBySenderIsOwner: mode === "in-process",
              modelOverrideFallbackOriginProvider: "custom",
              modelOverrideFallbackOriginModel: expected,
            }
          : {}),
      });
    }
  } finally {
    runs.releaseAgentRunDelegatedAuthority(delegatedAuthority);
  }
});
