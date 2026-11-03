import { asOptionalRecord } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetPutResult,
} from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { READ_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const SESSION_KEY = "agent:main:generated-identity-restart";
const widgets = [
  { title: "売上レポート 2024", key: "a", fallbackName: "2024-aaaaaaaa", html: "sales" },
  { title: "在庫レポート 2024", key: "b", fallbackName: "2024-bbbbbbbb", html: "inventory" },
] as const;

function putGeneratedWidget(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  params: (typeof widgets)[number],
  revised = false,
) {
  return client.request<BoardWidgetPutResult>("board.widget.put", {
    sessionKey: SESSION_KEY,
    name: "2024",
    title: params.title,
    content: { kind: "html", html: `<p>${params.html}${revised ? " revised" : ""}</p>` },
    generatedIdentity: {
      source: "show_widget",
      key: params.key.repeat(64),
      fallbackName: params.fallbackName,
    },
  });
}

it("preserves concurrent generated identities across restart", { timeout: 120_000 }, async () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: { ...process.env } });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: SESSION_KEY, storePath: database.path },
    { sessionId: "generated-identity-restart", updatedAt: Date.now() },
  );

  const events: string[] = [];
  const start = async () => {
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const server = await startTestGatewayServer(portClaim, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    return { port: portClaim.port, server };
  };
  const connect = (port: number, deviceFamily: string) =>
    connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      deviceFamily,
      scopes: [READ_SCOPE, WRITE_SCOPE],
      onEvent: (event) => {
        const widget = asOptionalRecord(event.payload)?.widget;
        if (event.event === "board.changed" && typeof widget === "string") {
          events.push(widget);
        }
      },
      timeoutMs: 30_000,
    });

  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let clients: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
  try {
    const first = await start();
    server = first.server;
    const [firstClient, secondClient] = await Promise.all([
      connect(first.port, "generated-a"),
      connect(first.port, "generated-b"),
    ]);
    clients = [firstClient, secondClient];
    const initial = await Promise.all([
      putGeneratedWidget(firstClient, widgets[0]),
      putGeneratedWidget(secondClient, widgets[1]),
    ]);
    const initialNames = initial.map((result) => result.resolvedWidgetName);
    expect(new Set(initialNames).size).toBe(2);
    expect(initialNames).toContain("2024");

    await Promise.all(clients.map(disconnectGatewayClient));
    clients = [];
    await server.close();
    server = undefined;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const restarted = await start();
    server = restarted.server;
    const reconnected = await connect(restarted.port, "generated-restart");
    clients = [reconnected];
    const snapshot = await reconnected.request<BoardSnapshot>("board.get", {
      sessionKey: SESSION_KEY,
    });
    expect(new Set(snapshot.widgets.map((widget) => widget.name))).toEqual(new Set(initialNames));

    const reloaded = await Promise.all(
      widgets.map((widget) => putGeneratedWidget(reconnected, widget, true)),
    );
    expect(new Set(reloaded.map((result) => result.resolvedWidgetName))).toEqual(
      new Set(initialNames),
    );
    expect(events).toEqual(expect.arrayContaining(initialNames));
  } finally {
    for (const client of clients) {
      await disconnectGatewayClient(client).catch(() => undefined);
    }
    await server?.close().catch(() => undefined);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  }
});
