import { onTestFinished, vi } from "vitest";
import type { BoardStore } from "../../boards/board-store.js";
import { createTestBoardStore } from "../../boards/board-store.test-support.js";
import * as canvasDocuments from "../../canvas/documents.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as mcpOperations from "../mcp-app-operations.js";
import * as mcpReconstruction from "../mcp-app-reconstruction.js";
import { createBoardHandlers } from "./board.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type BoardMcpAppDependencies = {
  resolveActiveView: typeof mcpOperations.resolveMcpAppActiveView;
  resolveAllowedToolNames: typeof mcpOperations.resolveMcpAppAllowedToolNames;
  mintFromTranscript: typeof mcpReconstruction.mintMcpAppViewFromTranscript;
};

export function createMcpAppDependencies(): BoardMcpAppDependencies {
  let lease = 0;
  const runtime = { getCatalog: vi.fn() };
  return {
    resolveActiveView: vi.fn(async ({ viewId }: { viewId: string }) => ({
      runtime,
      view: {
        viewId,
        serverName: "server",
        toolName: "tool",
        uiResourceUri: "ui://resource",
        toolCallId: "call",
        allowedAppToolNames: new Set(["server.refresh", "server.search"]),
      },
    })),
    resolveAllowedToolNames: vi.fn(async () => ["server.refresh", "server.search"]),
    mintFromTranscript: vi.fn(async ({ readOnly }: { readOnly: boolean }) => {
      lease += 1;
      return {
        runtime,
        view: {
          viewId: `mcp-app-board-${lease}`,
          expiresAtMs: 10_000 + lease,
          ...(readOnly ? { readOnly: true as const } : {}),
        },
      };
    }),
  } as unknown as BoardMcpAppDependencies;
}

export function createBoardHarness(
  readCanvasHtml?: typeof canvasDocuments.readCanvasDocumentHtmlSource,
  dependencies: Partial<BoardMcpAppDependencies> = {},
  store: BoardStore = createTestBoardStore(),
  contextOverrides: Partial<GatewayRequestContext> = {},
  client: GatewayClient | null = null,
) {
  const mcpApp = { ...createMcpAppDependencies(), ...dependencies };
  const mocks = [
    vi.spyOn(mcpOperations, "resolveMcpAppActiveView").mockImplementation(mcpApp.resolveActiveView),
    vi
      .spyOn(mcpOperations, "resolveMcpAppAllowedToolNames")
      .mockImplementation(mcpApp.resolveAllowedToolNames),
    vi
      .spyOn(mcpReconstruction, "mintMcpAppViewFromTranscript")
      .mockImplementation(mcpApp.mintFromTranscript),
    readCanvasHtml
      ? vi.spyOn(canvasDocuments, "readCanvasDocumentHtmlSource").mockImplementation(readCanvasHtml)
      : undefined,
  ];
  const broadcast = vi.fn();
  const handlers = createBoardHandlers(store);
  const context = {
    broadcast,
    getMcpAppSandboxPort: () => 18790,
    getSessionEventSubscriberConnIds: () => [],
    getRuntimeConfig: () => ({
      agents: { entries: { main: {} } },
      mcp: { apps: { enabled: true } },
      tools: { exec: { mode: "ask" } },
    }),
    ...contextOverrides,
  } as unknown as GatewayRequestContext;
  setRuntimeConfigSnapshot(context.getRuntimeConfig());
  onTestFinished(() => {
    clearRuntimeConfigSnapshot();
    mocks.forEach((mock) => mock?.mockRestore());
  });
  context.resolveGatewayContext ??= () => context;
  const invoke = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn<RespondFn>();
    await handlers[method]!({
      req: { type: "req", id: "test", method, params },
      params,
      client,
      isWebchatConnect: () => false,
      respond,
      context,
    });
    return respond;
  };
  return { store, broadcast, context, handlers, invoke, mcpApp };
}
