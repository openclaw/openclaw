import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { READ_SCOPE, SESSION_WRITE_SCOPE } from "../operator-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createModelsListTestContext } from "./models-list-result.openai-routes.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

const catalog: ModelCatalogEntry[] = ["primary", "fallback", "restricted-model", "custom"].map(
  (id) => ({ id, name: id, provider: "example", api: "openai-completions" }),
);

function createFixture(
  catalogDiagnostics?: Parameters<typeof createModelsListTestContext>[0]["catalogDiagnostics"],
  restrictedDefault = false,
) {
  const person = ensureProfileForEmail("model-reader@example.test");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: restrictedDefault ? "example/restricted-model" : "example/primary",
          fallbacks: restrictedDefault
            ? ["example/fallback"]
            : ["example/restricted-model", "example/fallback"],
        },
        models: { "example/custom": { alias: "custom-choice" } },
        modelPolicy: { allow: ["example/*"] },
      },
      entries: { main: {} },
    },
    models: {
      mode: "replace",
      providers: {
        example: {
          baseUrl: "https://example.invalid",
          models: catalog.map<ModelDefinitionConfig>(({ id, name }) => ({
            id,
            name,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 4096,
          })),
        },
      },
    },
    gateway: {
      roles: {
        default: "visitor",
        definitions: {
          visitor: {
            agents: ["main"],
            scopes: [SESSION_WRITE_SCOPE],
            sessions: { others: "view" },
            modelPolicy: { sourceAgent: "main", deny: ["example/restricted-*"] },
          },
          staff: {
            agents: "*",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            sessions: { others: "write" },
          },
        },
      },
    },
  };
  const role = expectDefined(cfg.gateway?.roles?.definitions.visitor, "visitor role");
  const client = identifiedClient(person.id);
  client.connect.scopes = [SESSION_WRITE_SCOPE];
  const catalogContext = createModelsListTestContext({
    cfg,
    catalog,
    catalogComplete: true,
    catalogDiagnostics,
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "example", providers: ["example"], syntheticAuthRefs: ["example"] }],
    }),
  });
  const context = createDirectChatContext({
    ...catalogContext,
    readChatMetadata: async () => ({ models: catalog, swarmEnabled: false }),
  });
  const request = async (
    method: Parameters<typeof handleGatewayRequest>[0]["req"]["method"],
    params: Record<string, unknown>,
  ) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: { type: "req", id: "model-policy", method, params },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
    return respond;
  };
  const save = async (state: OpenClawTestState) => {
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
  };
  const staff = () => {
    setUserProfileRole(person.id, "staff");
    invalidateOperatorRolePolicy(person.id);
    client.connect.scopes = ["operator.admin", "operator.read", "operator.write"];
  };
  const tentative = () => {
    const draft = structuredClone(cfg);
    const draftRole = expectDefined(draft.gateway?.roles?.definitions.visitor, "tentative role");
    delete draftRole.modelPolicy;
    context.getRuntimeConfig = () => draft;
    context.getCommittedRuntimeConfig = () => cfg;
    return draftRole;
  };
  const seedSession = async (
    sessionId: string,
    extra: Partial<Parameters<typeof upsertSessionEntryCore>[1]> = {},
  ) => {
    const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}` };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: person.id },
      providerOverride: "example",
      modelOverride: "restricted-model",
      modelOverrideSource: "user",
      ...extra,
    });
    return scope;
  };
  return { cfg, role, client, context, request, save, staff, tentative, seedSession };
}

async function readCatalog(
  f: ReturnType<typeof createFixture>,
  method: "models.list" | "chat.metadata",
  view?: string,
) {
  const respond = await f.request(method, { agentId: "main", ...(view ? { view } : {}) });
  response(respond);
  return respond.mock.calls[0]?.[1] as ModelsListResult;
}

function response(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond.mock.calls).toEqual([[true, expect.anything(), undefined]]);
  return expectDefined(asOptionalRecord(respond.mock.calls[0]?.[1]), "response payload");
}

function onlyRecord(value: unknown) {
  const rows = expectDefined(Array.isArray(value) ? value : undefined, "record list");
  expect(rows).toHaveLength(1);
  return expectDefined(asOptionalRecord(rows[0]), "record");
}

function modelIds(result: Pick<ModelsListResult, "models">) {
  return result.models.map(({ id }) => id).toSorted();
}

function expectHidden(value: unknown, ...fields: string[]) {
  for (const field of fields) {
    expect(value).not.toHaveProperty(field);
  }
}

describe("operator model discovery at registered reads", () => {
  it.each([
    { policy: { allow: [] }, defaultModel: null, acceptsReset: false },
    {
      policy: { deny: ["example/restricted-*"] },
      defaultModel: "example/fallback",
      acceptsReset: true,
    },
  ])("keeps registered Default resets aligned with $defaultModel", async (expected) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = createFixture(undefined, true);
      f.role.modelPolicy = expected.policy;
      await f.save(state);
      const scope = await f.seedSession("model-default");
      const saved = expectDefined(loadSessionEntry(scope), "saved session");
      f.context.readPreparedGatewayModelCatalog = async () => ({ entries: catalog });
      await initializeSessionReadContext(f.context);

      expect(response(await f.request("models.list", { agentId: "main" }))).toMatchObject({
        modelSelectionPolicy: { restricted: true, defaultModel: expected.defaultModel },
      });
      const reset = await f.request("sessions.patch", { key: scope.sessionKey, model: null });
      expect(reset.mock.calls).toHaveLength(1);
      expect(reset.mock.calls[0]?.[0]).toBe(expected.acceptsReset);
      const after = expectDefined(loadSessionEntry(scope), "reset session");
      if (expected.acceptsReset) {
        expect(after.modelOverride).toBeUndefined();
      } else {
        expect(reset.mock.calls[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
        expect(after).toEqual(saved);
      }
    });
  });

  it("filters every catalog view and metadata, while preserving Staff and permitted custom choices", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const diagnostics = {
        pendingProviders: ["example", "hidden-family"],
        providerOutcomes: [
          { provider: "example", status: "ready" as const },
          { provider: "example", profileId: "example:private", status: "auth-rejected" as const },
          {
            provider: "hidden-family",
            profileId: "hidden-family:private",
            status: "unavailable" as const,
          },
        ],
        refreshFailed: true,
      };
      const f = createFixture(diagnostics);
      await f.save(state);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      prepareGatewayRecipientProfile(f.client);
      const read = (method: "models.list" | "chat.metadata", view?: string) =>
        readCatalog(f, method, view);
      for (const tentative of [false, true]) {
        if (tentative) {
          f.tentative();
        }
        for (const view of ["default", "configured", "all", "provider-config"]) {
          const result = await read("models.list", view);
          expect(modelIds(result)).toEqual(["fallback", "primary"]);
          expect(result.modelSelectionPolicy).toEqual({
            restricted: true,
            defaultModel: "example/primary",
          });
          expect(result.pendingProviders).toEqual(["example"]);
          expect(result.providerOutcomes).toEqual([{ provider: "example", status: "ready" }]);
          expect(result.refreshFailed).toBe(false);
        }
        expect(modelIds(await read("chat.metadata"))).toEqual(["fallback", "primary"]);
      }
      f.context.getRuntimeConfig = () => f.cfg;

      f.role.modelPolicy = {
        sourceAgent: "main",
        allow: ["example/primary", "example/fallback", "custom-choice"],
        deny: ["example/restricted-*"],
      };
      const custom = await read("models.list", "configured");
      expect(modelIds(custom)).toEqual(["custom", "fallback", "primary"]);
      expect(custom.models.find(({ id }) => id === "custom")?.alias).toBe("custom-choice");

      const presentation = expectDefined(
        prepareOperatorModelPresentation({ cfg: f.cfg, policyConfig: f.cfg, client: f.client }),
        "restricted presentation",
      ).forAgent("main", catalog);
      const accountResult = {
        ...custom,
        ...diagnostics,
        accountSelection: {
          kind: "personal" as const,
          label: "Selected account",
          authProfileId: "example:private",
        },
      };
      expect(presentation.catalog(accountResult)).toMatchObject({
        providerOutcomes: diagnostics.providerOutcomes.slice(0, 2),
        refreshFailed: true,
      });
      expect(
        presentation.catalog({
          ...accountResult,
          accountSelection: { kind: "personal", label: "Personal account" },
        }),
      ).toMatchObject({
        providerOutcomes: [{ provider: "example", status: "ready" }],
        refreshFailed: false,
      });

      f.role.modelPolicy = { sourceAgent: "main", allow: [] };
      expect(await read("models.list", "all")).toMatchObject({
        models: [],
        modelSelectionPolicy: { restricted: true, defaultModel: null },
        pendingProviders: [],
        providerOutcomes: [],
        refreshFailed: false,
      });
      f.staff();
      const staff = await read("models.list", "all");
      expect(modelIds(staff)).toEqual(["custom", "fallback", "primary", "restricted-model"]);
      expect(staff).not.toHaveProperty("modelSelectionPolicy");
      expect(staff).toMatchObject(diagnostics);
    });
  });

  it.each([
    { utilityModel: "example/fallback", routeVisible: true },
    { utilityModel: "example/restricted-model", routeVisible: false },
  ])(
    "discloses the utility route only when $utilityModel is visible to the role",
    async ({ utilityModel, routeVisible }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const f = createFixture();
        expectDefined(f.cfg.agents?.defaults, "agent defaults").utilityModel = utilityModel;
        expectDefined(f.cfg.models?.providers?.example, "example provider").apiKey =
          "synthetic-key";
        await f.save(state);
        const { defaultModels } = await readCatalog(f, "models.list", "configured");
        if (routeVisible) {
          expect(defaultModels?.utilityRuntime).toEqual({
            id: "openclaw",
            kind: "api",
            label: "OpenClaw Default",
          });
        } else {
          expect(defaultModels).toBeDefined();
          expect(defaultModels).not.toHaveProperty("utilityRuntime");
        }
      });
    },
  );

  it("does not publish held metadata after a role policy change", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = createFixture();
      await f.save(state);
      const entered = createDeferred();
      const release = createDeferred();
      vi.spyOn(f.context, "readChatMetadata").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { models: catalog, swarmEnabled: false };
      });
      const pending = f.request("chat.metadata", { agentId: "main" });
      const settled = Promise.allSettled([pending]);
      try {
        await Promise.race([entered.promise, pending]);
        f.context.getRuntimeConfig = () => ({
          ...f.cfg,
          gateway: {
            roles: {
              default: "visitor",
              definitions: { visitor: { ...f.role, modelPolicy: { allow: [] } } },
            },
          },
        });
      } finally {
        release.resolve();
        await settled;
      }
      await expect(pending).rejects.toThrow("access changed");
    });
  });

  it("hides forbidden historical models without rewriting stored selections or transcript content", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = createFixture(undefined, true);
      await f.save(state);
      const tentativeRole = f.tentative();
      const budget = contextBudgetStatusFixture({
        provider: "example",
        model: "restricted-model",
        sessionId: "historical-model",
      });
      const scope = await f.seedSession("historical-model", {
        modelProvider: "example",
        model: "restricted-model",
        agentHarnessId: "openclaw",
        contextTokens: 200_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: budget,
      });
      const transcriptScope = { ...scope, sessionId: "historical-model" };
      const content = "The text example/restricted-model remains part of the conversation.";
      await appendTranscriptMessage(transcriptScope, {
        eventId: "historical-reply",
        message: {
          role: "assistant",
          provider: "example",
          model: "restricted-model",
          content,
          stopReason: "stop",
        },
      });
      const saved = loadSessionEntry(scope);
      const savedTranscript = await loadTranscriptEvents(transcriptScope);
      f.context.readPreparedGatewayModelCatalog = async () => ({ entries: catalog });
      f.context.readChatStartupProjection = async () => ({
        metadata: { models: catalog, swarmEnabled: false },
        sessionModelCatalog: catalog,
        defaultModelCatalog: catalog,
      });
      await initializeSessionReadContext(f.context);

      const startupPayload = response(await f.request("chat.startup", scope));
      expect(startupPayload).toMatchObject({
        defaults: { model: "fallback", modelProvider: "example" },
        sessionInfo: { sessionId: "historical-model" },
        metadata: expect.objectContaining({
          models: [expect.objectContaining({ id: "fallback" })],
          modelSelectionPolicy: { restricted: true, defaultModel: "example/fallback" },
        }),
      });
      expectHidden(startupPayload.sessionInfo, "model", "modelProvider", "contextBudgetStatus");
      const startupMessage = onlyRecord(startupPayload.messages);
      expect(startupMessage).toMatchObject({ role: "assistant", content });
      expectHidden(startupMessage, "model", "provider");

      f.role.scopes = [READ_SCOPE];
      tentativeRole.scopes = [READ_SCOPE];
      f.client.connect.scopes = [READ_SCOPE];
      expect(response(await f.request("agents.list", {}))).toMatchObject({
        agents: expect.arrayContaining([
          expect.objectContaining({
            id: "main",
            model: { primary: "example/fallback", fallbacks: ["example/fallback"] },
          }),
        ]),
      });

      for (const staff of [false, true]) {
        if (staff) {
          f.staff();
        }
        for (const [method, target, rowField, messageField] of [
          ["chat.history", { sessionKey: scope.sessionKey }, "sessionInfo", "messages"],
          [
            "chat.message.get",
            { sessionKey: scope.sessionKey, messageId: "historical-reply" },
            null,
            "message",
          ],
          ["sessions.get", { key: scope.sessionKey }, null, "messages"],
          ["sessions.describe", { key: scope.sessionKey }, "session", null],
          ["sessions.list", {}, "sessions", null],
        ] as const) {
          const payload = response(await f.request(method, { agentId: scope.agentId, ...target }));
          if (rowField) {
            if (method === "sessions.list" && !staff) {
              expect(payload.defaults).toMatchObject({
                model: "fallback",
                modelProvider: "example",
              });
            }
            const row =
              rowField === "sessions"
                ? onlyRecord(payload[rowField])
                : expectDefined(payload[rowField], `${method} row`);
            expect(row).toMatchObject({ key: scope.sessionKey });
            if (staff) {
              expect(row).toMatchObject({ modelProvider: "example", model: "restricted-model" });
              expect(row).toHaveProperty("contextBudgetStatus", budget);
            } else {
              expectHidden(row, "model", "modelProvider", "contextBudgetStatus");
            }
          }
          if (messageField) {
            const message =
              messageField === "message"
                ? expectDefined(payload[messageField], "exact message")
                : onlyRecord(payload[messageField]);
            expect(message).toMatchObject({ role: "assistant", content });
            if (staff) {
              expect(message).toMatchObject({ provider: "example", model: "restricted-model" });
            } else {
              expectHidden(message, "model", "provider");
            }
          }
        }
      }
      expect(loadSessionEntry(scope)).toEqual(saved);
      expect(await loadTranscriptEvents(transcriptScope)).toEqual(savedTranscript);
    });
  });
});
