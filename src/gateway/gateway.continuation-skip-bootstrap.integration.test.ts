import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Registered in gatewayDatabaseWorkerTestFiles: only that project's forked pool gives this Gateway a
// host SQLite broker. One Gateway for the file, no handler or transport mocks.
it("continuation-skip stops re-sending workspace instructions on the next turn", async () => {
  const state = await createOpenClawTestState({
    label: "continuation-skip-bootstrap",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
  });
  const sentinel = `BSKIP-${randomUUID()}`;
  const requests: string[] = [];
  const providerWork: Promise<void>[] = [];
  const endpoint = createServer((request, response) => {
    const work = (async () => {
      requests.push(await readRequestText(request));
      writeOpenAiResponsesText(response, {
        text: "CONTINUATION_SKIP_REPLY",
        messageId: `msg_${randomUUID()}`,
        responseId: `resp_${randomUUID()}`,
      });
    })();
    providerWork.push(work);
    void work.catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const claim = await acquireTestPortBlock({ offsets: [0] });
  try {
    await new Promise<void>((resolve) => {
      endpoint.listen(claim.port, "127.0.0.1", resolve);
    });
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture provider did not bind a TCP port");
    }
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "continuation-proof",
    );
    // No BOOTSTRAP.md: bootstrapMode "none" must still record the completion marker.
    await fs.writeFile(
      path.join(state.workspaceDir, "AGENTS.md"),
      `# Continuation proof workspace\n\nSentinel ${sentinel}\n`,
    );
    const token = "continuation-skip-gateway-token";
    const cfg = {
      gateway: {
        mode: "local",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        reload: { mode: "off" },
      },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          contextInjection: "continuation-skip",
          model: { primary: model.modelRef, fallbacks: [] },
          heartbeat: { every: "0m" },
        },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          [model.providerId]: { ...model.config, agentRuntime: { id: "openclaw" } },
        },
      },
      hooks: { enabled: false },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    const { client, server } = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin"],
    });
    try {
      await server.startupSettled;
      const sessionKey = `agent:main:continuation-${randomUUID()}`;
      const turn = async (message: string): Promise<string> => {
        const requestStart = requests.length;
        const started = await client.request<{ runId: string; status: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        // Keep the client's deadline beyond the server-side wait on loaded runners.
        await expect(
          client.request<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        const sent = requests.slice(requestStart);
        expect(sent).toHaveLength(1);
        return sent[0]!;
      };

      expect(await turn("Name the workspace sentinel.")).toContain(sentinel);
      expect(await turn("And now the sentinel again?")).not.toContain(sentinel);
    } finally {
      try {
        await disconnectGatewayClient(client);
      } finally {
        await server.close({ reason: "Continuation-skip replay complete" });
      }
    }
  } finally {
    endpoint.closeAllConnections();
    try {
      if (endpoint.listening) {
        await closeHttpServer(endpoint);
      }
      await Promise.all(providerWork);
    } finally {
      await claim.release();
      await state.cleanup();
    }
  }
}, 90000);
