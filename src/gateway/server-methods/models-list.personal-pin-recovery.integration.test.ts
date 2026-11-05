import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { ChatMetadataResult } from "./chat-metadata-contract.js";
import {
  catalogAgents,
  catalogReply,
  catalogSessionRpc,
  createCatalogAuthProfiles,
  createCatalogModel,
  createCatalogState,
  expectAssistantReply,
} from "./models-catalog-fixture.test-support.js";
import {
  modelsTestConfig,
  serveModelsEndpoint,
  startModelsGateway,
} from "./models-integration.test-support.js";

it(
  "recovers a saved session from a missing personal account through explicit selection",
  { timeout: 120_000 },
  async () => {
    await using state = await createCatalogState("missing-personal-pin-recovery");
    const token = "personal-pin-recovery-gateway-token";
    const missingPin =
      "personal:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002";
    const scope = { agentId: "main", sessionKey: "agent:main:main" };
    const primary = "recovery-primary";
    const alternative = "recovery-alternative";
    const model = createCatalogModel("recovery-model");
    const authorizations: Array<string | undefined> = [];
    const endpoint = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        catalogReply(
          `recovery-${authorizations.length}`,
          model.id,
          `Recovery reply ${authorizations.length}`,
        ),
      );
    });
    await using listening = await serveModelsEndpoint(endpoint);
    const config = modelsTestConfig(state, token, {
      agents: catalogAgents(state, {
        model: { primary: `${primary}/${model.id}` },
        models: { [`${primary}/*`]: {}, [`${alternative}/*`]: {} },
      }),
      models: {
        providers: Object.fromEntries(
          [primary, alternative].map((provider) => [
            provider,
            {
              baseUrl: `${listening.baseUrl}/v1`,
              api: "openai-completions" as const,
              request: { allowPrivateNetwork: true },
              models: [model],
            },
          ]),
        ),
      },
    });
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    await state.writeAuthProfiles(
      createCatalogAuthProfiles({
        [primary]: "synthetic-primary-key",
        [alternative]: "synthetic-alternative-key",
      }),
    );
    await using gateway = await startModelsGateway(state, config, token);
    const sessions = catalogSessionRpc(gateway.client);
    const send = async (message: string, key: string) => {
      const run = await sessions.send(scope.sessionKey, message, key);
      expect(await sessions.wait(run.runId)).toMatchObject({ status: "ok" });
    };
    await send("Reply before the account becomes unavailable.", "personal-pin-before");
    const originalSessionId = loadSessionEntry(scope)?.sessionId;
    expect(originalSessionId).toBeTruthy();
    expect(loadSessionEntry(scope)?.modelProvider).toBe(primary);
    await patchSessionEntryCore(scope, () => ({
      authProfileOverride: missingPin,
      authProfileOverrideSource: "user-link",
    }));
    const catalog = () =>
      gateway.client.request<ModelsListResult>("models.list", {
        sessionKey: scope.sessionKey,
        view: "configured",
      });
    const expectRecoveryCatalog = async () => {
      const results = await Promise.all([
        catalog(),
        gateway.client.request<ChatMetadataResult>("chat.metadata", {
          agentId: "main",
          sessionKey: scope.sessionKey,
        }),
      ]);
      for (const result of results) {
        expect(result.models).toContainEqual(
          expect.objectContaining({ provider: alternative, id: model.id, available: true }),
        );
        expect(result.models).toContainEqual(
          expect.objectContaining({ provider: primary, id: model.id, available: false }),
        );
      }
      expect(loadSessionEntry(scope)?.authProfileOverride).toBe(missingPin);
    };
    await expectRecoveryCatalog();
    const currentConfig = await gateway.client.request<{ hash: string }>("config.get", {});
    await gateway.client.request("config.patch", {
      baseHash: currentConfig.hash,
      raw: JSON.stringify({
        agents: { defaults: { model: { primary: `${alternative}/${model.id}` } } },
      }),
    });
    await expectRecoveryCatalog();
    await gateway.client.request("sessions.patch", {
      key: scope.sessionKey,
      model: `${primary}/${model.id}@${primary}:default`,
    });
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: originalSessionId,
      authProfileOverride: `${primary}:default`,
      authProfileOverrideSource: "user",
    });
    expect((await catalog()).models).toContainEqual(
      expect.objectContaining({
        provider: primary,
        id: model.id,
        available: true,
      }),
    );
    await send("Continue the same session after account selection.", "personal-pin-after");
    await patchSessionEntryCore(scope, () => ({
      authProfileOverride: missingPin,
      authProfileOverrideSource: "user-link",
    }));
    await expectRecoveryCatalog();
    await gateway.client.request("sessions.patch", {
      key: scope.sessionKey,
      model: `${alternative}/${model.id}`,
    });
    expect(loadSessionEntry(scope)?.authProfileOverride).toBeUndefined();
    await send("Continue after selecting another provider.", "personal-pin-provider");
    expect(authorizations).toEqual([
      "Bearer synthetic-primary-key",
      "Bearer synthetic-primary-key",
      "Bearer synthetic-alternative-key",
    ]);
    const history = await sessions.history(scope.sessionKey);
    expectAssistantReply(history.messages, "Recovery reply 1");
    expectAssistantReply(history.messages, "Recovery reply 2");
    expectAssistantReply(history.messages, "Recovery reply 3");
    expect(loadSessionEntry(scope)?.sessionId).toBe(originalSessionId);
  },
);
