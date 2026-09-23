import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Routing project: gateway-database-workers; one Gateway for the file, no handler or transport mocks.
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
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push(Buffer.concat(chunks).toString("utf8"));
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
  try {
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    const address = endpoint.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture provider did not bind a TCP port");
    }
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "continuation-proof",
    );
    // A workspace without BOOTSTRAP.md resolves bootstrapMode "none", which is the state where
    // main never records the completion marker and every later turn keeps re-injecting.
    await fs.mkdir(state.workspaceDir, { recursive: true });
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
          // The skip is an embedded-runner contract; pin it so the run cannot take a
          // CLI-backed harness, which does not consult contextInjection at all.
          models: { [model.modelRef]: { agentRuntime: { id: "openclaw" } } },
          heartbeat: { every: "0m" },
        },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: { [model.providerId]: model.config },
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
        await expect(
          client.request("agent.wait", { runId: started.runId, timeoutMs: 30000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const sent = requests.slice(requestStart);
        expect(sent).toHaveLength(1);
        return sent[0]!;
      };

      const first = await turn("Name the workspace sentinel.");
      expect(first).toContain(sentinel);
      // This second request is the shipped outcome: the settled turn recorded the marker, so the
      // same session no longer pays for workspace instructions it already received.
      const second = await turn("And now the sentinel again?");
      expect(second).not.toContain(sentinel);
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
        await new Promise<void>((resolve, reject) => {
          endpoint.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await Promise.all(providerWork);
    } finally {
      await state.cleanup();
    }
  }
}, 90000);
