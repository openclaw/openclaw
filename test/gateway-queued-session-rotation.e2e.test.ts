import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayChatClient } from "../src/tui/gateway-chat.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

type MockModelRequest = {
  body: Record<string, unknown>;
};

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  releaseHeldResponse: () => void;
  stop: () => Promise<void>;
};

const TEST_TIMEOUT_MS = 150_000;
const WAIT_OPTS = { timeout: 30_000, interval: 20 } as const;

const instances: OpenClawTestInstance[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function createQueuedRotationConfig(fixtureDir: string, baseUrl: string): OpenClawConfig {
  const modelRef = "queued-rotation/queued-rotation";
  return {
    agents: {
      defaults: {
        workspace: path.join(fixtureDir, "workspace"),
        model: { primary: modelRef },
        modelPolicy: { allow: [modelRef] },
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        skills: [],
        skipBootstrap: true,
      },
      entries: { main: { model: { primary: modelRef }, skills: [] } },
    },
    tools: { profile: "minimal" },
    models: createOpenAiResponsesModelConfig({
      baseUrl,
      providerId: "queued-rotation",
      modelId: "queued-rotation",
      reasoning: false,
      toolProfile: "minimal",
    }).models,
    messages: { queue: { mode: "followup" } },
  };
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const heldResponse = createDeferred();
  const server = await startOpenAiResponsesModelServer({
    modelId: "queued-rotation",
    bindError: "mock model server did not bind",
    onRequest: async (req, res) => {
      requests.push({ body: await readJsonRequest(req) });
      if (requests.length === 1) {
        await heldResponse.promise;
        if (res.destroyed) {
          return;
        }
      }
      writeOpenAiResponsesText(res, {
        text: requests.length === 1 ? "FIRST_TURN_COMPLETE" : "RESET_TURN_COMPLETE",
        messageId: "msg_queued_rotation",
        responseId: "resp_queued_rotation",
      });
    },
  });
  let stopped = false;
  return {
    baseUrl: server.baseUrl,
    requests,
    releaseHeldResponse: () => heldResponse.resolve(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      heldResponse.resolve();
      await server.close();
    },
  };
}

async function writeTurnTracerPlugin(pluginDir: string, tracePath: string): Promise<void> {
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "queued-rotation-tracer",
      name: "Queued Rotation Tracer",
      description: "Records agent-turn preparation for the queued session rotation E2E test.",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await writeFile(
    path.join(pluginDir, "index.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "export default {",
      '  id: "queued-rotation-tracer",',
      '  name: "Queued Rotation Tracer",',
      "  register(api) {",
      '    api.on("agent_turn_prepare", () => {',
      `      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ prepared: true }) + "\\n");`,
      "      return {};",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

async function readTraceCount(tracePath: string): Promise<number> {
  try {
    return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function startScenario(name: string, trace = false) {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), `openclaw-${name}-`));
  cleanupDirs.push(fixtureDir);
  const modelServer = await startMockModelServer();
  modelServers.push(modelServer);
  const config = createQueuedRotationConfig(fixtureDir, modelServer.baseUrl);
  const tracePath = path.join(fixtureDir, "turns.ndjson");
  if (trace) {
    const pluginDir = path.join(fixtureDir, "plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeTurnTracerPlugin(pluginDir, tracePath);
    config.plugins = {
      enabled: true,
      allow: ["queued-rotation-tracer"],
      load: { paths: [pluginDir] },
      entries: {
        "queued-rotation-tracer": { enabled: true, hooks: { allowConversationAccess: true } },
      },
      slots: { memory: "none" },
    };
  }
  const instance = await createOpenClawTestInstance({
    name,
    gatewayToken: "secret-token",
    config,
    env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
  });
  instances.push(instance);
  await instance.startGateway();
  const client = new GatewayChatClient({ url: instance.url, token: "secret-token" });
  client.start();
  await client.waitForReady();
  return { instance, client, modelServer, tracePath };
}

describe("Gateway queued session rotation", () => {
  it(
    "runs a replacement turn after /new cancels an active turn",
    async () => {
      const { client, modelServer, tracePath } = await startScenario(
        "queued-session-rotation",
        true,
      );
      const sessionKey = "agent:main:queued-rotation-e2e";
      try {
        const first = await client.sendChat({
          sessionKey,
          message: "OPENCLAW_E2E_HELD_TURN",
          runId: "queued-rotation-held",
        });
        expect(first.status).toBe("started");
        await vi.waitFor(async () => {
          expect(modelServer.requests).toHaveLength(1);
          expect(await readTraceCount(tracePath)).toBe(1);
        }, WAIT_OPTS);

        const replacement = await client.sendChat({
          sessionKey,
          message: "/new OPENCLAW_E2E_AFTER_RESET",
          runId: "queued-rotation-reset",
        });
        expect(replacement.status).toBe("started");

        // The accepted reset turn must keep its lifecycle through cancellation and
        // rotation; losing it here leaves the turn before both hook and model entry.
        await vi.waitFor(async () => {
          expect(modelServer.requests).toHaveLength(2);
          expect(await readTraceCount(tracePath)).toBe(2);
        }, WAIT_OPTS);
        expect(JSON.stringify(modelServer.requests[0]?.body)).toContain("OPENCLAW_E2E_HELD_TURN");
        expect(JSON.stringify(modelServer.requests[1]?.body)).toContain("OPENCLAW_E2E_AFTER_RESET");
      } finally {
        await client.abortChat({ sessionKey }).catch(() => undefined);
        void client.stop();
        modelServer.releaseHeldResponse();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops without retrying a queued followup during shutdown",
    async () => {
      const { instance, client, modelServer } = await startScenario("followup-drain-restart");
      const sessionKey = "agent:main:followup-drain-restart-e2e";
      try {
        const first = await client.sendChat({
          sessionKey,
          message: "OPENCLAW_E2E_HELD_BEFORE_RESTART",
          runId: "followup-restart-held",
        });
        expect(first.status).toBe("started");
        await vi.waitFor(() => expect(modelServer.requests).toHaveLength(1), WAIT_OPTS);

        const second = await client.sendChat({
          sessionKey,
          message: "OPENCLAW_E2E_QUEUED_DURING_RESTART",
          runId: "followup-restart-queued",
        });
        expect(second.status).toBe("started");
        await vi.waitFor(async () => {
          const history = (await client.loadHistory({ sessionKey })) as {
            pendingInputs?: ChatPendingInputsPage;
          };
          expect(history.pendingInputs?.items).toEqual([
            expect.objectContaining({
              runId: "followup-restart-queued",
              state: "queued",
              queued: true,
            }),
          ]);
          expect(modelServer.requests).toHaveLength(1);
        }, WAIT_OPTS);

        const child = instance.child;
        if (!child) {
          throw new Error("gateway child is missing");
        }
        child.kill("SIGTERM");
        await vi.waitFor(
          () => expect(instance.logs()).toContain("received SIGTERM; shutting down"),
          WAIT_OPTS,
        );
        modelServer.releaseHeldResponse();

        await vi.waitFor(() => {
          const exited = child.exitCode !== null || child.signalCode !== null;
          const drainFailures = instance.logs().match(/followup queue drain failed/g)?.length ?? 0;
          expect(exited || drainFailures >= 2).toBe(true);
        }, WAIT_OPTS);

        const drainFailures = instance.logs().match(/followup queue drain failed/g)?.length ?? 0;
        expect(drainFailures).toBe(0);
        expect(modelServer.requests).toHaveLength(1);
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        void client.stop();
        modelServer.releaseHeldResponse();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
