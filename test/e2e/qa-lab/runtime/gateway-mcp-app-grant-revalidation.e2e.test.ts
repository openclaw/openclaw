import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  buildQaGatewayConfig,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import type {
  BoardSnapshot,
  BoardWidgetAppViewResult,
  BoardWidgetPutResult,
  EventFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  TEST_TIMEOUT_MS,
  createChildEnv,
  startHttpFixture,
  stopChild,
  waitForMcpFixtureGate,
  type HttpFixture,
} from "./gateway-node-mcp.test-support.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

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
  gateway: { baseUrl: string },
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
  "isolates shared-board pins by requester and rejects tool calls revoked during catalog refresh",
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
    const fixturePath = path.join(repoRoot, "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs");
    let startingFixture: Promise<HttpFixture> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    let instance: OpenClawTestInstance | undefined;
    const clients: SkillLibraryWireClient[] = [];
    let pendingCall: Promise<Response> | undefined;
    const cleanupErrors: unknown[] = [];
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        const acquiredFixture = await startingFixture?.catch(() => undefined);
        await fs.writeFile(releasePath, "released\n").catch(() => {});
        await pendingCall?.catch(() => {});
        const closed = await Promise.allSettled(clients.map((client) => client.close()));
        const stopped = await Promise.allSettled([
          ...(instance ? [instance.cleanup()] : []),
          ...(acquiredFixture ? [stopChild(acquiredFixture)] : []),
          ...(mock ? [Promise.resolve(mock.stop())] : []),
        ]);
        cleanupErrors.push(
          ...[...closed, ...stopped].flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          ),
        );
      })());
    onTestFinished(cleanup);

    await runQaGatewayFixture(
      async () => {
        await Promise.all(
          [fixtureHome, fixtureTemp, gateDir].map((directory) =>
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
        instance = await createSkillLibraryWireInstance({ signal });
        const authConfig = JSON.parse(
          await fs.readFile(instance.configPath, "utf8"),
        ) as OpenClawConfig;
        const config = appConfig(
          buildQaGatewayConfig({
            bind: "loopback",
            gatewayPort: instance.port,
            gatewayToken: instance.gatewayToken,
            workspaceDir: instance.state.workspaceDir,
            providerBaseUrl: `${mock.baseUrl}/v1`,
            providerMode: "mock-openai",
            primaryModel: "mock-openai/gpt-5.6-luna",
            controlUiEnabled: false,
            enabledPluginIds: ["openai"],
          }),
          fixture,
        );
        config.gateway = {
          ...authConfig.gateway,
          // Shared-board write access does not confer ownership of another person's preview.
          roles: {
            default: "writer",
            definitions: {
              writer: {
                sessions: { others: "write" },
                agents: "*",
                scopes: ["operator.admin", "operator.read", "operator.write"],
              },
            },
          },
        };
        config.agents!.defaults!.models!["mock-openai/gpt-5.6-luna"]!.agentRuntime = {
          id: "openclaw",
        };
        await instance.state.writeConfig(config);
        const childEnv = createChildEnv({
          home: instance.homeDir,
          tempDir: fixtureTemp,
          extra: {
            ...instance.state.envVars,
            OPENCLAW_BUILD_PRIVATE_QA: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
          },
        });
        for (const key of Object.keys(instance.env)) {
          delete instance.env[key];
        }
        Object.assign(instance.env, childEnv);
        await instance.startGateway();
        const connect = async (options?: Parameters<typeof SkillLibraryWireClient.connect>[1]) => {
          const connected = await SkillLibraryWireClient.connect(instance!, options);
          clients.push(connected.client);
          return connected;
        };
        const { hello } = await connect();
        const boardEvents: EventFrame[] = [];
        const { client: alice } = await connect({
          email: SKILL_LIBRARY_ALICE,
          scopes: ["operator.admin", ...SKILL_LIBRARY_WRITER_SCOPES],
          buildId: hello.server.buildId,
          onEvent: (event) => {
            if (event.event === "board.changed") {
              boardEvents.push(event);
            }
          },
        });
        const { client: bob, hello: bobHello } = await connect({
          email: SKILL_LIBRARY_BOB,
          buildId: hello.server.buildId,
        });
        expect(bobHello.auth?.scopes?.toSorted()).toEqual(
          [...SKILL_LIBRARY_WRITER_SCOPES].toSorted(),
        );
        const aliceId = (await alice.request<{ profile: { id: string } }>("users.self", {})).profile
          .id;
        const bobId = (await bob.request<{ profile: { id: string } }>("users.self", {})).profile.id;
        expect(aliceId).not.toBe(bobId);
        await alice.request("sessions.subscribe", {});
        const gateway = { baseUrl: `http://127.0.0.1:${instance.port}` };
        const sessionKey = `agent:qa:mcp-app-grant-${randomUUID()}`;
        await alice.request("sessions.create", {
          key: sessionKey,
          agentId: "qa",
          visibility: "shared",
          worktree: false,
          cwd: instance.state.workspaceDir,
        });
        const started = (await alice.request(
          "agent",
          {
            sessionKey,
            message: `Tool search QA check target=${APP_TOOL_NAME}. Call exactly that tool once and then summarize.`,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          30_000,
        )) as { runId?: unknown; status?: unknown };
        if (started.status !== "accepted" || typeof started.runId !== "string") {
          throw new Error(`mock-provider App turn did not start: ${JSON.stringify(started)}`);
        }
        await expect(
          alice.request("agent.wait", { runId: started.runId, timeoutMs: 60_000 }, 65_000),
        ).resolves.toMatchObject({ runId: started.runId, status: "ok" });
        const history = (await alice.request("chat.history", {
          sessionKey,
          limit: 50,
        })) as { messages?: unknown[] };
        const sourceViewId = requireMcpAppViewId(history.messages ?? []);

        const control = await bob.request<BoardWidgetPutResult>("board.widget.put", {
          sessionKey,
          name: "bob-control",
          content: { kind: "html", html: "<p>Bob can write this shared board</p>" },
        });
        // Read on the observing socket fences events already published before the RPC reply.
        await alice.request("board.get", { sessionKey });
        expect(control.widgets.map((widget) => widget.name)).toEqual(["bob-control"]);
        expect(
          boardEvents.map((event) => (isRecord(event.payload) ? event.payload.widget : undefined)),
        ).toEqual(["bob-control"]);
        boardEvents.length = 0;
        const markersBefore = await readExecutedMarkers(eventPath);
        await expect(
          bob.request("board.widget.put", {
            sessionKey,
            name: "foreign-pin",
            content: { kind: "mcp-app", viewId: sourceViewId },
          }),
        ).rejects.toThrow("MCP App view expired or is not authorized for this session");
        const afterRejectedPin = await alice.request<BoardSnapshot>("board.get", { sessionKey });
        expect(afterRejectedPin.revision).toBe(control.revision);
        expect(afterRejectedPin.widgets.map((widget) => widget.name)).toEqual(["bob-control"]);
        expect(boardEvents).toEqual([]);
        expect(await readExecutedMarkers(eventPath)).toEqual(markersBefore);
        console.info(
          "[mcp-board-requester-proof]",
          JSON.stringify({
            distinctAuthenticatedProfiles: aliceId !== bobId,
            bobScopes: bobHello.auth?.scopes,
            bobControlWidget: control.resolvedWidgetName,
            revisionBefore: control.revision,
            revisionAfterRejectedPin: afterRejectedPin.revision,
            widgetsAfterRejectedPin: afterRejectedPin.widgets.map((widget) => widget.name),
            publishedEventsAfterRejectedPin: boardEvents.length,
            toolCallsAfterRejectedPin:
              (await readExecutedMarkers(eventPath)).length - markersBefore.length,
          }),
        );
        const pinned = (await alice.request("board.widget.put", {
          sessionKey,
          name: "grant-proof",
          content: { kind: "mcp-app", viewId: sourceViewId },
        })) as BoardWidgetPutResult;
        const widget = pinned.widgets.find((candidate) => candidate.name === "grant-proof");
        if (!widget?.instanceId) {
          throw new Error("board.widget.put omitted the exact widget revision identity");
        }
        expect(widget.grantState).toBe("pending");
        await alice.request("board.get", { sessionKey });
        expect(
          boardEvents.map((event) => (isRecord(event.payload) ? event.payload.widget : undefined)),
        ).toEqual(["grant-proof"]);
        console.info(
          "[mcp-board-requester-proof]",
          JSON.stringify({
            alicePinnedWidget: widget.name,
            grantState: widget.grantState,
            publishedEventsAfterAlicePin: boardEvents.length,
          }),
        );
        const widgetRef = {
          sessionKey,
          name: widget.name,
          revision: widget.revision,
          instanceId: widget.instanceId,
        };
        await alice.request("board.widget.grant", {
          ...widgetRef,
          decision: "granted",
        });
        const reminted = (await alice.request(
          "board.widget.appView",
          widgetRef,
        )) as BoardWidgetAppViewResult;
        const appView = (await alice.request("mcp.app.view", {
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
        await alice.request("board.update", {
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
