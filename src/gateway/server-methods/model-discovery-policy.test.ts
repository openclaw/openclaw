import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
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
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
) {
  const person = ensureProfileForEmail("model-reader@example.test");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: {
          primary: "example/primary",
          fallbacks: ["example/restricted-model", "example/fallback"],
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
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "example", providers: ["example"], syntheticAuthRefs: ["example"] }],
  });
  const catalogContext = createModelsListTestContext({
    cfg,
    catalog,
    catalogComplete: true,
    metadataSnapshot,
    catalogDiagnostics,
  });
  const readChatMetadata = vi.fn(async () => ({ models: catalog, swarmEnabled: false }));
  const context = createDirectChatContext({ ...catalogContext, readChatMetadata });
  const request = async (
    method:
      | "models.list"
      | "chat.metadata"
      | "chat.startup"
      | "chat.history"
      | "chat.message.get"
      | "agents.list"
      | "sessions.list"
      | "sessions.describe"
      | "sessions.get"
      | "sessions.patch",
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
  return { cfg, role, person, client, context, readChatMetadata, request };
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
      const f = createFixture();
      expectDefined(f.cfg.agents?.defaults, "agent defaults").model = {
        primary: "example/restricted-model",
        fallbacks: ["example/fallback"],
      };
      f.role.modelPolicy = expected.policy;
      await state.writeConfig(f.cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:model-default" };
      await upsertSessionEntryCore(scope, {
        sessionId: "model-default",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: f.person.id },
        providerOverride: "example",
        modelOverride: "restricted-model",
        modelOverrideSource: "user",
      });
      const saved = expectDefined(loadSessionEntry(scope), "saved session");
      f.context.readPreparedGatewayModelCatalog = async () => ({ entries: catalog });
      await initializeSessionReadContext(f.context);

      const models = await f.request("models.list", { agentId: "main" });
      expect(models.mock.calls).toHaveLength(1);
      expect(models.mock.calls[0]?.[0]).toBe(true);
      expect(models.mock.calls[0]?.[1]).toMatchObject({
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
      await state.writeConfig(f.cfg);
      const read = async (method: "models.list" | "chat.metadata", view?: string) => {
        const respond = await f.request(method, { agentId: "main", ...(view ? { view } : {}) });
        expect(respond.mock.calls).toHaveLength(1);
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        return respond.mock.calls[0]?.[1] as ModelsListResult;
      };
      for (const view of ["default", "configured", "all", "provider-config"]) {
        const result = await read("models.list", view);
        expect(result.models.map(({ id }) => id).toSorted()).toEqual(["fallback", "primary"]);
        expect(result.modelSelectionPolicy).toEqual({
          restricted: true,
          defaultModel: "example/primary",
        });
        expect(result.pendingProviders).toEqual(["example"]);
        expect(result.providerOutcomes).toEqual([{ provider: "example", status: "ready" }]);
        expect(result.refreshFailed).toBe(false);
      }
      expect((await read("chat.metadata")).models.map(({ id }) => id).toSorted()).toEqual([
        "fallback",
        "primary",
      ]);

      const tentative = structuredClone(f.cfg);
      delete expectDefined(tentative.gateway?.roles?.definitions.visitor, "tentative role")
        .modelPolicy;
      f.context.getRuntimeConfig = () => tentative;
      f.context.getCommittedRuntimeConfig = () => f.cfg;
      for (const view of ["default", "configured", "all", "provider-config"]) {
        expect((await read("models.list", view)).models.map(({ id }) => id).toSorted()).toEqual([
          "fallback",
          "primary",
        ]);
      }
      expect((await read("chat.metadata")).models.map(({ id }) => id).toSorted()).toEqual([
        "fallback",
        "primary",
      ]);
      f.context.getRuntimeConfig = () => f.cfg;

      f.role.modelPolicy = {
        sourceAgent: "main",
        allow: ["example/primary", "example/fallback", "custom-choice"],
        deny: ["example/restricted-*"],
      };
      const custom = await read("models.list", "configured");
      expect(custom.models.map(({ id }) => id).toSorted()).toEqual([
        "custom",
        "fallback",
        "primary",
      ]);
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
      setUserProfileRole(f.person.id, "staff");
      invalidateOperatorRolePolicy(f.person.id);
      f.client.connect.scopes = ["operator.admin", "operator.read", "operator.write"];
      const staff = await read("models.list", "all");
      expect(staff.models.map(({ id }) => id).toSorted()).toEqual([
        "custom",
        "fallback",
        "primary",
        "restricted-model",
      ]);
      expect(staff).not.toHaveProperty("modelSelectionPolicy");
      expect(staff).toMatchObject(diagnostics);
    });
  });

  it("does not publish held metadata after a role policy change", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = createFixture();
      await state.writeConfig(f.cfg);
      const entered = createDeferred();
      const release = createDeferred();
      f.readChatMetadata.mockImplementationOnce(async () => {
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
      const f = createFixture();
      expectDefined(f.cfg.agents?.defaults, "agent defaults").model = {
        primary: "example/restricted-model",
        fallbacks: ["example/fallback"],
      };
      await state.writeConfig(f.cfg);
      const tentative = structuredClone(f.cfg);
      const tentativeRole = expectDefined(
        tentative.gateway?.roles?.definitions.visitor,
        "tentative role",
      );
      delete tentativeRole.modelPolicy;
      f.context.getRuntimeConfig = () => tentative;
      f.context.getCommittedRuntimeConfig = () => f.cfg;
      const scope = { agentId: "main", sessionKey: "agent:main:historical-model" };
      const budget = contextBudgetStatusFixture({
        provider: "example",
        model: "restricted-model",
        sessionId: "historical-model",
      });
      await upsertSessionEntryCore(scope, {
        sessionId: "historical-model",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: f.person.id },
        providerOverride: "example",
        modelOverride: "restricted-model",
        modelOverrideSource: "user",
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

      const startup = await f.request("chat.startup", scope);
      expect(startup).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          defaults: expect.objectContaining({ model: "fallback", modelProvider: "example" }),
          sessionInfo: expect.objectContaining({ sessionId: "historical-model" }),
          metadata: expect.objectContaining({
            models: [expect.objectContaining({ id: "fallback" })],
            modelSelectionPolicy: { restricted: true, defaultModel: "example/fallback" },
          }),
        }),
      );
      const startupPayload = expectDefined(
        asOptionalRecord(startup.mock.calls[0]?.[1]),
        "startup payload",
      );
      expect(startupPayload.sessionInfo).not.toHaveProperty("model");
      expect(startupPayload.sessionInfo).not.toHaveProperty("modelProvider");
      expect(startupPayload.sessionInfo).not.toHaveProperty("contextBudgetStatus");
      expect(startupPayload.messages).toMatchObject([{ role: "assistant", content }]);
      const startupMessages = expectDefined(
        Array.isArray(startupPayload.messages) ? startupPayload.messages : undefined,
        "startup messages",
      );
      expect(startupMessages).toHaveLength(1);
      expect(startupMessages[0]).not.toHaveProperty("model");
      expect(startupMessages[0]).not.toHaveProperty("provider");

      // Roster reads also apply the model ceiling when the caller holds their registered read scope.
      f.role.scopes = [READ_SCOPE];
      tentativeRole.scopes = [READ_SCOPE];
      f.client.connect.scopes = [READ_SCOPE];
      const agents = await f.request("agents.list", {});
      expect(agents).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          agents: expect.arrayContaining([
            expect.objectContaining({
              id: "main",
              model: { primary: "example/fallback", fallbacks: ["example/fallback"] },
            }),
          ]),
        }),
        undefined,
      );
      const sessions = await f.request("sessions.list", { agentId: "main" });
      expect(sessions).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          defaults: expect.objectContaining({ model: "fallback", modelProvider: "example" }),
          sessions: expect.arrayContaining([expect.objectContaining({ key: scope.sessionKey })]),
        }),
      );
      const roster = expectDefined(asOptionalRecord(sessions.mock.calls[0]?.[1]), "roster");
      const rosterRows = expectDefined(
        Array.isArray(roster.sessions) ? roster.sessions : undefined,
        "roster rows",
      );
      expect(rosterRows).toHaveLength(1);
      expect(rosterRows[0]).not.toHaveProperty("model");
      expect(rosterRows[0]).not.toHaveProperty("modelProvider");
      expect(rosterRows[0]).not.toHaveProperty("contextBudgetStatus");

      for (const staff of [false, true]) {
        if (staff) {
          setUserProfileRole(f.person.id, "staff");
          invalidateOperatorRolePolicy(f.person.id);
          f.client.connect.scopes = ["operator.admin", "operator.read", "operator.write"];
        }
        for (const method of [
          "chat.history",
          "chat.message.get",
          "sessions.get",
          "sessions.describe",
          "sessions.list",
        ] as const) {
          const response = await f.request(method, {
            agentId: scope.agentId,
            ...(method.startsWith("chat.")
              ? { sessionKey: scope.sessionKey }
              : method === "sessions.list"
                ? {}
                : { key: scope.sessionKey }),
            ...(method === "chat.message.get" ? { messageId: "historical-reply" } : {}),
          });
          expect(response.mock.calls).toHaveLength(1);
          expect(response.mock.calls[0]?.[0]).toBe(true);
          const payload = expectDefined(asOptionalRecord(response.mock.calls[0]?.[1]), method);
          if (
            method === "chat.history" ||
            method === "sessions.describe" ||
            method === "sessions.list"
          ) {
            if (method === "sessions.list") {
              expect(payload.sessions).toHaveLength(1);
            }
            const rows = Array.isArray(payload.sessions) ? payload.sessions : undefined;
            const row = expectDefined(
              payload.sessionInfo ?? payload.session ?? rows?.[0],
              `${method} row`,
            );
            expect(row).toMatchObject({ key: scope.sessionKey });
            if (staff) {
              expect(row).toMatchObject({ modelProvider: "example", model: "restricted-model" });
              expect(row).toHaveProperty("contextBudgetStatus", budget);
            } else {
              expect(row).not.toHaveProperty("model");
              expect(row).not.toHaveProperty("modelProvider");
              expect(row).not.toHaveProperty("contextBudgetStatus");
            }
          }
          if (
            method === "chat.history" ||
            method === "chat.message.get" ||
            method === "sessions.get"
          ) {
            const messages = expectDefined(
              method === "chat.message.get"
                ? [expectDefined(payload.message, "exact message")]
                : Array.isArray(payload.messages)
                  ? payload.messages
                  : undefined,
              `${method} messages`,
            );
            expect(messages).toHaveLength(1);
            for (const message of messages) {
              expect(message).toMatchObject({ role: "assistant", content });
              if (staff) {
                expect(message).toMatchObject({ provider: "example", model: "restricted-model" });
              } else {
                expect(message).not.toHaveProperty("model");
                expect(message).not.toHaveProperty("provider");
              }
            }
          }
        }
      }
      expect(loadSessionEntry(scope)).toEqual(saved);
      expect(await loadTranscriptEvents(transcriptScope)).toEqual(savedTranscript);
    });
  });
});
