import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
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
    await patchSessionEntryCore(scope, () => ({
      authProfileOverride: missingPin,
      authProfileOverrideSource: "user-link",
    }));
    const catalog = () =>
      gateway.client.request<ModelsListResult>("models.list", {
        sessionKey: scope.sessionKey,
        view: "configured",
      });
    const before = await catalog();
    expect(before.models).toContainEqual(
      expect.objectContaining({
        provider: alternative,
        id: model.id,
        available: true,
      }),
    );
    expect(before.models).toContainEqual(
      expect.objectContaining({
        provider: primary,
        id: model.id,
        available: false,
      }),
    );
    expect(loadSessionEntry(scope)?.authProfileOverride).toBe(missingPin);
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
    expect(authorizations).toEqual([
      "Bearer synthetic-primary-key",
      "Bearer synthetic-primary-key",
    ]);
    const history = await sessions.history(scope.sessionKey);
    expectAssistantReply(history.messages, "Recovery reply 1");
    expectAssistantReply(history.messages, "Recovery reply 2");
    expect(loadSessionEntry(scope)?.sessionId).toBe(originalSessionId);
  },
);
