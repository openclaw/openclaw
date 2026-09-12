import { expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { ModelsSnapshotEvent } from "../../../packages/gateway-protocol/src/index.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "../test-helpers.e2e.js";

it("connect publishes the roster default or valid requested agent's catalog without an ambient owner or models.list request", async () => {
  const state = await createOpenClawTestState({
    label: "models-connect-publication",
    env: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    },
  });
  const port = await getGatewayE2ePortBlock();
  const token = "synthetic-catalog-gateway-token";
  const publications: ModelsSnapshotEvent[] = [];
  try {
    state.applyEnv();
    const { client, server } = await startGatewayWithClient({
      port,
      configPath: state.configPath,
      token,
      clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${port}`,
      scopes: ["operator.admin"],
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token },
          controlUi: { root: state.workspaceDir, allowedOrigins: [`http://127.0.0.1:${port}`] },
        },
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: {
            alpha: {
              workspace: state.workspaceDir,
              model: "fixture/first",
              modelPolicy: { allow: ["fixture/first"] },
            },
            bravo: {
              workspace: state.statePath("bravo"),
              model: "fixture/second",
              modelPolicy: { allow: ["fixture/second"] },
            },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9/v1",
              apiKey: "synthetic-key",
              models: [
                { id: "first", name: "First model" },
                { id: "second", name: "Second model" },
              ],
            },
          },
        },
      },
      onEvent(event) {
        if (event.event === "models.snapshot") {
          publications.push(event.payload as ModelsSnapshotEvent);
        }
      },
    });
    try {
      await expect
        .poll(() => publications, { timeout: 15_000 })
        .toMatchObject([
          {
            agentId: "alpha",
            catalog: { models: [{ id: "first", provider: "fixture", available: true }] },
          },
        ]);
      for (const selection of [
        { hint: "bravo", agentId: "bravo", modelId: "second" },
        { hint: "missing", agentId: "alpha", modelId: "first" },
      ]) {
        const otherPublications: ModelsSnapshotEvent[] = [];
        const other = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          clientName: GATEWAY_CLIENT_IDS.CONTROL_UI,
          modelCatalogAgentId: selection.hint,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin: `http://127.0.0.1:${port}`,
          scopes: ["operator.admin"],
          onEvent(event) {
            if (event.event === "models.snapshot") {
              otherPublications.push(event.payload as ModelsSnapshotEvent);
            }
          },
        });
        try {
          await expect
            .poll(() => otherPublications)
            .toMatchObject([
              {
                agentId: selection.agentId,
                catalog: {
                  models: [{ id: selection.modelId, provider: "fixture", available: true }],
                },
              },
            ]);
          expect(publications).toHaveLength(1);
        } finally {
          await disconnectGatewayClient(other);
        }
      }
    } finally {
      await disconnectGatewayClient(client);
      await server.close({ reason: "catalog publication test complete" });
    }
  } finally {
    await state.cleanup();
  }
}, 60_000);
