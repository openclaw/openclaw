import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";

it.each([true, false])(
  "models.list and session changes separate manual policy from defaults and auth=%s",
  async (authenticated) => {
    const state = await createOpenClawTestState({
      label: "manual-model-policy",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const token = "manual-policy-fixture-token";
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "fixture/automatic", fallbacks: ["fixture/fallback"] },
          modelPolicy: { allow: ["fixture/manual"] },
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          fixture: {
            api: "openai-completions",
            auth: "api-key",
            apiKey: authenticated ? "synthetic-policy-key" : undefined,
            baseUrl: "https://policy.example.invalid/v1",
            models: ["manual", "automatic", "fallback"].map((id) => ({ id, name: id })),
          },
        },
      },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token }, reload: { mode: "off" } },
    };
    try {
      const { client, server, port } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const legacy = await client.request<ModelsListResult>("models.list", {
          agentId: "main",
          view: "configured",
        });
        expect(legacy.models.map((model) => model.id)).toEqual(["automatic", "fallback", "manual"]);
        expect(
          legacy.models.every((model) => !Object.hasOwn(model, "manualSelectionAllowed")),
        ).toBe(true);
        const modern = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          scopes: ["operator.admin"],
          caps: ["model-selection-policy"],
        });
        try {
          const negotiated = await modern.request<ModelsListResult>("models.list", {
            agentId: "main",
            view: "configured",
          });
          expect(negotiated.models.find((model) => model.id === "manual")?.available).toBe(
            authenticated,
          );
          expect(
            negotiated.models.map(({ id, manualSelectionAllowed }) => ({
              id,
              manualSelectionAllowed,
            })),
          ).toEqual([
            { id: "automatic", manualSelectionAllowed: false },
            { id: "fallback", manualSelectionAllowed: false },
            { id: "manual", manualSelectionAllowed: true },
          ]);
          expect(
            negotiated.models.map(({ manualSelectionAllowed: _permission, ...row }) => row),
          ).toEqual(legacy.models);
        } finally {
          await disconnectGatewayClient(modern);
        }
        const catalog = await client.request<ModelsListResult>("models.list", { agentId: "main" });
        expect
          .soft(catalog.models.map(({ provider, id }) => `${provider}/${id}`))
          .toEqual(["fixture/manual"]);
        const key = "agent:main:manual-policy";
        await client.request("sessions.create", { key, agentId: "main", model: "fixture/manual" });
        for (const model of ["fixture/automatic", "fixture/fallback"]) {
          await expect
            .soft(client.request("sessions.patch", { key, model }))
            .rejects.toThrow("model not allowed");
        }
        const started = await client.request<{ runId: string }>("chat.send", {
          sessionKey: key,
          message: "/model default",
          idempotencyKey: `manual-policy-default-reset-${authenticated}`,
        });
        // chat.send only acknowledges admission; observe command completion before its effects.
        await expect(client.request("agent.wait", { runId: started.runId })).resolves.toMatchObject(
          { status: "ok" },
        );
        const history = await client.request<{ sessionInfo: { model: string } }>("chat.history", {
          sessionKey: key,
        });
        expect(history.sessionInfo.model).toBe("automatic");
        await client.request("sessions.patch", { key, model: "fixture/manual" });
        await expect(client.request("sessions.patch", { key, model: null })).resolves.toBeDefined();
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "Manual policy test complete" });
      }
    } finally {
      await state.cleanup();
    }
  },
);
