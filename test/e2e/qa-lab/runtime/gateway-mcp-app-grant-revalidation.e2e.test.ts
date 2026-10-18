import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import type {
  BoardWidgetAppViewResult,
  BoardWidgetPutResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  TEST_TIMEOUT_MS,
  createChildEnv,
  startHttpFixture,
  stopChild,
  waitForMcpFixtureGate,
  type GatewayHandle,
  type HttpFixture,
} from "./gateway-node-mcp.test-support.js";

const APP_TOOL_NAME = "streamableHttp__parity_app";
const POST_REVOCATION_MARKER = "post-revocation";

function requireMcpAppViewId(messages: unknown[]): string {
  for (const message of messages) {
    if (!isRecord(message) || message.toolName !== APP_TOOL_NAME || !isRecord(message.details)) {
      continue;
    }
    const preview = message.details.mcpAppPreview;
    const mcpApp = isRecord(preview) ? preview.mcpApp : undefined;
    if (isRecord(mcpApp) && typeof mcpApp.viewId === "string") {
      return mcpApp.viewId;
    }
  }
  throw new Error(`chat.history omitted the persisted MCP App view for ${APP_TOOL_NAME}`);
}

async function readExecutedMarkers(eventPath: string): Promise<string[]> {
  const content = await fs.readFile(eventPath, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
    .flatMap((event) =>
      isRecord(event) && typeof event.marker === "string" ? [event.marker] : [],
    );
}

function appConfig(cfg: OpenClawConfig, fixture: HttpFixture): OpenClawConfig {
  return {
    ...cfg,
    mcp: {
      ...cfg.mcp,
      apps: { ...cfg.mcp?.apps, enabled: true },
      servers: {
        streamableHttp: {
          transport: "streamable-http",
          url: fixture.urls.streamableHttp,
          connectionTimeoutMs: 30_000,
          requestTimeoutMs: 30_000,
          toolFilter: { include: ["parity_app"] },
        },
      },
    },
    tools: {
      ...cfg.tools,
      profile: "full",
      toolSearch: false,
      codeMode: false,
      exec: { ...cfg.tools?.exec, mode: "ask" },
    },
    channels: {},
  };
}

function postStandalone(
  gateway: GatewayHandle,
  ticket: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Response> {
  return fetch(new URL("/__openclaw__/mcp-app/view", gateway.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `MCP-App ${ticket}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
  });
}

it(
  "rejects a standalone tool call revoked during a real catalog refresh",
  { timeout: TEST_TIMEOUT_MS },
  async ({ signal, onTestFinished }) => {
    // Finish hooks run in reverse order: join children before deleting their paths.
    const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const repoRoot = process.cwd();
    const taskRoot = tempDirs.make("openclaw-mcp-app-grant-revalidation-");
    const fixtureRoot = path.join(taskRoot, "fixture");
    const fixtureHome = path.join(fixtureRoot, "home");
    const fixtureTemp = path.join(fixtureRoot, "tmp");
    const gateDir = path.join(fixtureRoot, "catalog-gate");
    const eventPath = path.join(fixtureRoot, "app-calls.jsonl");
    const armPath = path.join(gateDir, "arm");
    const startedPath = path.join(gateDir, "started");
    const releasePath = path.join(gateDir, "release");
    const gatewayParent = path.join(taskRoot, "gateway");
    const fixturePath = path.join(repoRoot, "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs");
    let startingFixture: Promise<HttpFixture> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    const gatewayOwner = createQaGatewayChild();
    let pendingCall: Promise<Response> | undefined;
    const cleanupErrors: unknown[] = [];
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        const acquiredFixture = await startingFixture?.catch(() => undefined);
        await fs.writeFile(releasePath, "released\n").catch(() => {});
        await pendingCall?.catch(() => {});
        const stopped = await Promise.allSettled([
          stopQaGatewayFixture(gatewayOwner),
          ...(acquiredFixture ? [stopChild(acquiredFixture)] : []),
          ...(mock ? [Promise.resolve(mock.stop())] : []),
        ]);
        cleanupErrors.push(
          ...stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
      })());
    onTestFinished(cleanup);

    await runQaGatewayFixture(
      async () => {
        await Promise.all(
          [fixtureHome, fixtureTemp, gateDir, gatewayParent].map((directory) =>
            fs.mkdir(directory, { recursive: true }),
          ),
        );
        startingFixture = startHttpFixture({
          fixturePath,
          signal,
          labelPrefix: "session",
          env: createChildEnv({
            home: fixtureHome,
            tempDir: fixtureTemp,
            extra: {
              MCP_APP_GRANT_REVALIDATION_FIXTURE: "1",
              MCP_APP_CATALOG_GATE_DIR: gateDir,
              MCP_APP_EVENT_PATH: eventPath,
            },
          }),
        });
        const fixture = await startingFixture;
        mock = await startQaMockOpenAiServer();
        const gateway = await gatewayOwner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            tempParentDir: gatewayParent,
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${mock.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: "mock-openai/gpt-5.6-luna",
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: { OPENCLAW_SKIP_CHANNELS: "1" },
          mutateConfig: (cfg) => appConfig(cfg, fixture),
        });

        const sessionKey = `agent:qa:mcp-app-grant-${randomUUID()}`;
        const started = (await gateway.call(
          "agent",
          {
            sessionKey,
            message: `Tool search QA check target=${APP_TOOL_NAME}. Call exactly that tool once and then summarize.`,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 30_000 },
        )) as { runId?: unknown; status?: unknown };
        if (started.status !== "accepted" || typeof started.runId !== "string") {
          throw new Error(`mock-provider App turn did not start: ${JSON.stringify(started)}`);
        }
        await expect(
          gateway.call(
            "agent.wait",
            { runId: started.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          ),
        ).resolves.toMatchObject({ runId: started.runId, status: "ok" });
        const history = (await gateway.call("chat.history", {
          sessionKey,
          limit: 50,
        })) as { messages?: unknown[] };
        const sourceViewId = requireMcpAppViewId(history.messages ?? []);

        const pinned = (await gateway.call("board.widget.put", {
          sessionKey,
          name: "grant-proof",
          content: { kind: "mcp-app", viewId: sourceViewId },
        })) as BoardWidgetPutResult;
        const widget = pinned.widgets.find((candidate) => candidate.name === "grant-proof");
        if (!widget?.instanceId) {
          throw new Error("board.widget.put omitted the exact widget revision identity");
        }
        expect(widget.grantState).toBe("pending");
        const widgetRef = {
          sessionKey,
          name: widget.name,
          revision: widget.revision,
          instanceId: widget.instanceId,
        };
        await gateway.call("board.widget.grant", {
          ...widgetRef,
          decision: "granted",
        });
        const reminted = (await gateway.call(
          "board.widget.appView",
          widgetRef,
        )) as BoardWidgetAppViewResult;
        const appView = (await gateway.call("mcp.app.view", {
          sessionKey,
          viewId: reminted.viewId,
        })) as { standaloneUrl?: unknown };
        if (typeof appView.standaloneUrl !== "string") {
          throw new Error("mcp.app.view omitted the standalone ticket URL");
        }
        const standaloneUrl = new URL(appView.standaloneUrl, gateway.baseUrl);
        const ticket = standaloneUrl.hash.slice(1);
        expect(ticket).not.toBe("");
        const readResource = () =>
          postStandalone(gateway, ticket, "resources/read", { uri: "ui://parity/app" });
        const callTool = (marker: string) =>
          postStandalone(gateway, ticket, "tools/call", {
            name: "parity_app",
            arguments: { marker },
          });

        const allowedResource = await readResource();
        const allowedResourceBody: unknown = await allowedResource.json();
        expect(allowedResource.status).toBe(200);
        expect(JSON.stringify(allowedResourceBody)).toContain("Parity MCP App");

        await fs.writeFile(armPath, "armed\n");
        const notificationCall = await callTool("notify-list-changed");
        expect(notificationCall.status).toBe(200);

        pendingCall = callTool(POST_REVOCATION_MARKER);
        await waitForMcpFixtureGate(startedPath, signal);
        await gateway.call("board.update", {
          sessionKey,
          ops: [{ kind: "widget_remove", name: widget.name }],
        });
        await fs.writeFile(releasePath, "released\n");

        const expectRevoked = async (response: Response) => {
          const body: unknown = await response.json();
          expect({
            status: response.status,
            error: isRecord(body) ? body.error : undefined,
          }).toEqual({ status: 403, error: "MCP App widget grant is no longer active" });
          return body;
        };
        await expectRevoked(await pendingCall);
        expect(JSON.stringify(await expectRevoked(await readResource()))).not.toContain(
          "Parity MCP App",
        );
        expect(await readExecutedMarkers(eventPath)).not.toContain(POST_REVOCATION_MARKER);
      },
      async () => {
        await cleanup();
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        }
        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, "MCP App grant revalidation cleanup failed");
        }
      },
    );
  },
);
