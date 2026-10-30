import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { handleArtifactDownloadHttpRequest } from "../artifact-downloads.js";
import { createSandboxHostHttpRequestHandler } from "../mcp-app-sandbox-http.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type SessionFilesOperation =
  | "list"
  | "get"
  | "download"
  | "assets"
  | "preview"
  | "preview.release"
  | "set"
  | "reveal";
type SessionFilesMethod = `sessions.files.${SessionFilesOperation}`;

type ResponderCall = { ok: boolean; payload?: unknown; error?: unknown };
type ReturnValueMock = { mockReturnValue: (value: unknown) => unknown };

export const TEXT_PREVIEW_FIXTURES = [
  { format: "RTF", mimeType: "application/rtf", content: "{\\rtf1\\ansi hello}" },
  { format: "XML", mimeType: "text/xml", content: '<?xml version="1.0"?><root/>' },
] as const;

export function createSessionFilesHandlerInvoker(handlers: GatewayRequestHandlers) {
  return async (
    method: SessionFilesMethod,
    params: Record<string, unknown>,
    context: Record<string, unknown> = {},
    options: Partial<
      Pick<
        GatewayRequestHandlerOptions,
        "client" | "withSessionTurnAuthority" | "sessionMutationAuthorization"
      >
    > = {},
  ) => {
    const calls: ResponderCall[] = [];
    await handlers[method]?.({
      req: { type: "req", id: method, method, params: {} },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        calls.push({ ok, payload, error });
      },
      context: {
        getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
        ...context,
      } as never,
      ...options,
    });
    return calls;
  };
}

export function createSessionFileDownloadClient() {
  const controller = new AbortController();
  const client: GatewayClient = {
    connId: "session-file-reader",
    connectionSignal: controller.signal,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      scopes: ["operator.admin"],
      client: { id: "test", version: "test", platform: "test", mode: "test" },
    },
  };
  return {
    client,
    fetch: (url: string, method?: string, headers?: Record<string, string>) =>
      fetchSessionFileDownload(client, url, method, headers),
    [Symbol.dispose]: () => controller.abort(),
  };
}

export function createSessionFilesClient(
  invoke: ReturnType<typeof createSessionFilesHandlerInvoker>,
  defaults: () => {
    sessionKey: string;
    context?: Record<string, unknown>;
    options?: Parameters<typeof invoke>[3];
  },
) {
  const request = (
    method: SessionFilesOperation,
    params: string | Record<string, unknown> = {},
    context?: Record<string, unknown>,
    options?: Parameters<typeof invoke>[3],
  ) => {
    const current = defaults();
    return invoke(
      `sessions.files.${method}`,
      {
        [method === "reveal" ? "key" : "sessionKey"]: current.sessionKey,
        ...(typeof params === "string" ? { path: params } : params),
      },
      context ?? current.context,
      options ?? current.options,
    );
  };
  return {
    request,
    ok: async (...args: Parameters<typeof request>) => expectOkPayload(await request(...args)),
    error: async (...args: Parameters<typeof request>) => expectError(await request(...args)),
  };
}

const downloadClients = new Set<GatewayClient>();
let downloadServer:
  | ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>
  | undefined;
afterAll(async () => {
  if (downloadServer) {
    const server = await downloadServer;
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
  }
});

export async function openSessionFileDownload(
  client: GatewayClient,
  url: string,
  init?: RequestInit,
) {
  downloadClients.clear();
  downloadClients.add(client);
  downloadServer ??= reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        void (async () => {
          if (
            !(await handleArtifactDownloadHttpRequest(req, res, {
              clients: downloadClients,
              basePath: "",
            }))
          ) {
            await createSandboxHostHttpRequestHandler({ clients: downloadClients })(req, res);
          }
        })();
      }),
  });
  const { claim } = await downloadServer;
  return fetch("http://127.0.0.1:" + claim.port + url, init);
}

export async function fetchSessionFileDownload(
  client: GatewayClient,
  url: string,
  method = "GET",
  headers?: Record<string, string>,
) {
  const result = await openSessionFileDownload(client, url, { method, headers });
  return {
    response: { statusCode: result.status, getHeader: (name: string) => result.headers.get(name) },
    body: method === "HEAD" ? undefined : new Uint8Array(await result.arrayBuffer()),
  };
}

export function expectOkPayload(calls: ResponderCall[]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload as Record<string, any>;
}

export function expectError(calls: ResponderCall[]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(false);
  return calls[0]?.error as Record<string, any>;
}

export function assistantToolCall(name: string, args: Record<string, unknown>) {
  return { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] };
}

export function visibleMessageEvent(message: unknown, seq: number) {
  return {
    event: { id: `event-${String(seq)}`, message },
    eventSeq: seq,
    parentId: seq > 1 ? `event-${String(seq - 1)}` : null,
    seq,
  };
}

export function createVisibleMessagesMock(readVisibleMessageDelta: ReturnValueMock) {
  return (messages: unknown[], cursor = "visible-messages-final"): void => {
    readVisibleMessageDelta.mockReturnValue({
      kind: "page",
      cursor,
      events: messages.map(visibleMessageEvent),
      hasMore: false,
      serializedBytes: 100,
    });
  };
}

export function writeWorkspaceFile(root: string, filePath: string, content: string): void {
  const resolved = path.join(root, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}

export function createWorkspaceFixture(prefix: string): string {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const workspaceRoot = fs.mkdtempSync(path.join(tempRoot, prefix));
  writeWorkspaceFile(workspaceRoot, "package.json", '{"name":"openclaw-test"}\n');
  writeWorkspaceFile(workspaceRoot, "src/readme.md", "# Read me\n");
  writeWorkspaceFile(workspaceRoot, "ui/chat.ts", "export const chat = true;\n");
  writeWorkspaceFile(workspaceRoot, "ui/vite.config.ts", "export default {};\n");
  return workspaceRoot;
}

export function removeWorkspaceFixture(workspaceRoot: string): void {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

export function prepareSessionFilesTest(
  mocks: {
    execOpenPath: ReturnValueMock & { mockResolvedValue: (value: unknown) => unknown };
    loadSessionEntry: ReturnValueMock;
    readDelta: ReturnValueMock & { mockReset: () => unknown };
    resolveAgentWorkspaceDir: ReturnValueMock;
    resolveDefaultAgentId: ReturnValueMock;
  },
  mockVisibleMessages: (messages: unknown[]) => void,
): string {
  vi.clearAllMocks();
  mocks.readDelta.mockReset();
  const workspaceRoot = createWorkspaceFixture("openclaw-session-files-test-");
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
  mocks.execOpenPath.mockResolvedValue(undefined);
  mocks.loadSessionEntry.mockReturnValue(createSessionEntryFixture(workspaceRoot, "sess-main"));
  mockVisibleMessages([
    assistantToolCall("edit", { path: "ui/chat.ts" }),
    assistantToolCall("read", { path: "src/readme.md" }),
    assistantToolCall("apply_patch", {
      input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
    }),
  ]);
  return workspaceRoot;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function createSessionEntryFixture(
  workspaceRoot: string,
  sessionId: string,
  storePath = path.join(workspaceRoot, ".sessions.json"),
  sessionFile = `${sessionId}.jsonl`,
) {
  return {
    agentId: "main",
    canonicalKey: "agent:main:main",
    cfg: {},
    storePath,
    entry: { sessionId, sessionFile, spawnedCwd: workspaceRoot },
  };
}

export function useSqliteSession(
  loadSessionEntry: ReturnValueMock,
  workspaceRoot: string,
  sessionId: string,
  storePath = path.join(workspaceRoot, `${sessionId}.sqlite`),
): string {
  loadSessionEntry.mockReturnValue(
    createSessionEntryFixture(
      workspaceRoot,
      sessionId,
      storePath,
      `sqlite:main:${sessionId}:${storePath}`,
    ),
  );
  return storePath;
}
