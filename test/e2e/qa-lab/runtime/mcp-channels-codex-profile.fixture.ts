// Codex-profile MCP assertions run against the packaged stdio bridge and real Gateway.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assert,
  connectMcpClient,
  type GatewayRpcClient,
  maybeApprovePendingBridgePairing,
  waitFor,
} from "./mcp-channels.fixture.ts";
import {
  connectMcpClientWithPairingReconnect,
  createMcpClientTempState,
} from "./mcp-client-temp-state.fixture.ts";

const OPAQUE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODEX_SESSION_TOOL_NAMES = [
  "openclaw_sessions_list",
  "openclaw_session_detail",
  "openclaw_session_create",
  "openclaw_session_send",
  "openclaw_session_abort",
  "openclaw_session_update",
] as const;
const appOnlyMetaSchema = z.object({
  ui: z.object({ visibility: z.tuple([z.literal("app")]) }),
});
const detailMetaSchema = z.object({
  "openai/ui": z.object({
    entrypoints: z.tuple([
      z.object({
        type: z.literal("sidebar-collection"),
        listTool: z.literal("openclaw_sessions_list"),
        replacesGlobal: z.literal(true),
        create: z.object({
          title: z.literal("New OpenClaw session"),
          toolArguments: z.object({ mode: z.literal("new"), chrome: z.literal("detail") }),
        }),
      }),
    ]),
  }),
  ui: z.object({
    resourceUri: z.literal("ui://openclaw/session"),
    visibility: z.tuple([z.literal("app")]),
  }),
});
const globalMetaSchema = z.object({
  "openai/ui": z.object({
    entrypoints: z.tuple([z.object({ type: z.literal("global") })]),
  }),
  ui: z.object({
    resourceUri: z.literal("ui://openclaw/session"),
    visibility: z.tuple([z.literal("app")]),
  }),
});

const codexSessionItemSchema = z
  .object({
    id: z.string().regex(OPAQUE_SESSION_ID_PATTERN),
    title: z.string(),
    archived: z.boolean(),
    toolArguments: z.object({
      session_id: z.string().regex(OPAQUE_SESSION_ID_PATTERN),
      chrome: z.literal("detail"),
    }),
  })
  .passthrough();

const codexSessionListResultSchema = z
  .object({
    structuredContent: z.object({ items: z.array(codexSessionItemSchema) }).passthrough(),
  })
  .passthrough();

const codexSessionDetailResultSchema = z
  .object({
    structuredContent: z
      .object({
        session: codexSessionItemSchema,
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string(),
          }),
        ),
      })
      .passthrough(),
  })
  .passthrough();

const codexSessionCreateResultSchema = z
  .object({
    structuredContent: z
      .object({
        session: codexSessionItemSchema,
        run_id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const codexSessionSendResultSchema = z
  .object({
    structuredContent: z
      .object({
        session_id: z.string().regex(OPAQUE_SESSION_ID_PATTERN),
        run_id: z.string().optional(),
        status: z.literal("working"),
      })
      .passthrough(),
  })
  .passthrough();

const codexSessionAbortResultSchema = z
  .object({
    structuredContent: z
      .object({
        session_id: z.string().regex(OPAQUE_SESSION_ID_PATTERN),
        aborted: z.boolean(),
        status: z.literal("idle"),
      })
      .passthrough(),
  })
  .passthrough();

const codexSessionUpdateResultSchema = z
  .object({
    structuredContent: z.object({ session: codexSessionItemSchema }).passthrough(),
  })
  .passthrough();

function requireCodexSession(items: Array<z.infer<typeof codexSessionItemSchema>>, title: string) {
  const session = items.find((item) => item.title === title);
  assert(session, `expected Codex session titled ${title}`);
  assert(
    session.toolArguments.session_id === session.id,
    `expected opaque detail arguments for ${title}`,
  );
  return session;
}

function assertNoRawGatewaySessionKeys(results: unknown[], keys: string[]): void {
  const serialized = JSON.stringify(results);
  for (const key of keys) {
    assert(!serialized.includes(key), `Codex MCP result leaked raw Gateway session key ${key}`);
  }
}

export async function runCodexSessionProfile(params: {
  gateway: GatewayRpcClient;
  gatewayUrl: string;
  gatewayToken: string;
}) {
  const codexTempState = createMcpClientTempState({ gatewayToken: params.gatewayToken });
  let codexHandle: Awaited<ReturnType<typeof connectMcpClient>> | undefined;
  const toolResults: unknown[] = [];
  try {
    codexHandle = await connectMcpClientWithPairingReconnect({
      tempState: codexTempState,
      connect: (tempState) =>
        connectMcpClient({
          gatewayUrl: params.gatewayUrl,
          gatewayToken: params.gatewayToken,
          profile: "codex",
          tempState,
        }),
      maybeApprovePairing: () => maybeApprovePendingBridgePairing(params.gateway),
    });
    const mcp = codexHandle.client;
    const callTool = async (toolParams: Parameters<typeof mcp.callTool>[0]) => {
      const result = await mcp.callTool(toolParams, undefined, { timeout: 240_000 });
      toolResults.push(result);
      assert(!result.isError, `${toolParams.name} should succeed`);
      return result;
    };

    const tools = await mcp.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const name of ["openclaw", ...CODEX_SESSION_TOOL_NAMES]) {
      assert(toolNames.has(name), `Codex profile missing ${name}`);
    }
    const listTool = tools.tools.find((tool) => tool.name === "openclaw_sessions_list");
    assert(listTool?.annotations?.readOnlyHint === true, "Codex list tool must be read-only");
    appOnlyMetaSchema.parse(listTool?._meta);
    detailMetaSchema.parse(
      tools.tools.find((tool) => tool.name === "openclaw_session_detail")?._meta,
    );
    globalMetaSchema.parse(tools.tools.find((tool) => tool.name === "openclaw")?._meta);
    const resources = await mcp.listResources();
    assert(
      resources.resources.some((resource) => resource.uri === "ui://openclaw/session"),
      "Codex profile missing OpenClaw MCP App resource",
    );
    const appResource = await mcp.readResource({ uri: "ui://openclaw/session" });
    assert(
      appResource.contents.some(
        (content) =>
          "text" in content &&
          typeof content.text === "string" &&
          content.text.includes("OpenClaw"),
      ),
      "Codex profile did not load the real OpenClaw session app",
    );

    const initialList = codexSessionListResultSchema.parse(
      await callTool({ name: "openclaw_sessions_list", arguments: { limit: 10 } }),
    ).structuredContent.items;
    const activeSeed = requireCodexSession(initialList, "Docker MCP Channel Smoke");
    const archivedSeed = requireCodexSession(initialList, "Docker MCP Archived");
    assert(!activeSeed.archived, "expected active seed in default Codex list");
    assert(archivedSeed.archived, "expected archived seed in default Codex list");

    const seededDetail = codexSessionDetailResultSchema.parse(
      await callTool({
        name: "openclaw_session_detail",
        arguments: { session_id: activeSeed.id },
      }),
    ).structuredContent;
    assert(
      seededDetail.messages.some((message) => message.text === "hello from seeded transcript"),
      "expected seeded transcript in Codex detail",
    );

    const createdLabel = `Docker Codex Session ${randomUUID()}`;
    const initialText = `OPENCLAW_E2E_ABORT_HOLD create ${randomUUID()}`;
    const createdResult = codexSessionCreateResultSchema.parse(
      await callTool({
        name: "openclaw_session_create",
        arguments: {
          agent_id: "main",
          label: createdLabel,
          message: initialText,
          operation_id: `create-${randomUUID()}`,
        },
      }),
    ).structuredContent;
    const created = createdResult.session;
    assert(created.title === createdLabel, "Codex create returned the wrong title");
    assert(!created.archived, "new Codex session should be active");
    assert(createdResult.run_id, "Codex create did not return the initial run id");

    const initialAborted = codexSessionAbortResultSchema.parse(
      await callTool({
        name: "openclaw_session_abort",
        arguments: {
          session_id: created.id,
          run_id: createdResult.run_id,
        },
      }),
    ).structuredContent;
    assert(initialAborted.aborted, "Codex abort did not stop the create-time held run");

    await waitFor(
      "initial message in Codex session detail",
      async () => {
        const detail = codexSessionDetailResultSchema.parse(
          await callTool({
            name: "openclaw_session_detail",
            arguments: { session_id: created.id },
          }),
        );
        return detail.structuredContent.messages.some((message) => message.text === initialText)
          ? detail
          : undefined;
      },
      60_000,
    );

    const createdGatewaySession = await waitFor(
      "created session in Gateway list",
      async () => {
        const listed = await params.gateway.request<{
          sessions?: Array<Record<string, unknown>>;
        }>("sessions.list", {
          archived: false,
          configuredAgentsOnly: true,
          includeDerivedTitles: true,
          limit: 50,
          search: createdLabel,
        });
        return listed.sessions?.find(
          (session) => session.label === createdLabel || session.displayName === createdLabel,
        );
      },
      60_000,
    );
    const createdGatewayKey = createdGatewaySession.key;
    assert(typeof createdGatewayKey === "string", "created Gateway session missing key");

    const sentText = `OPENCLAW_E2E_ABORT_HOLD ${randomUUID()}`;
    const sent = codexSessionSendResultSchema.parse(
      await callTool({
        name: "openclaw_session_send",
        arguments: {
          session_id: created.id,
          text: sentText,
          operation_id: `send-${randomUUID()}`,
        },
      }),
    ).structuredContent;
    assert(sent.session_id === created.id, "Codex send returned the wrong opaque session id");

    const aborted = codexSessionAbortResultSchema.parse(
      await callTool({
        name: "openclaw_session_abort",
        arguments: {
          session_id: created.id,
          ...(sent.run_id ? { run_id: sent.run_id } : {}),
        },
      }),
    ).structuredContent;
    assert(aborted.session_id === created.id, "Codex abort returned the wrong opaque session id");
    assert(aborted.aborted, "Codex abort did not stop the held Gateway run");

    await waitFor(
      "sent message in Codex session detail",
      async () => {
        const detail = codexSessionDetailResultSchema.parse(
          await callTool({
            name: "openclaw_session_detail",
            arguments: { session_id: created.id },
          }),
        );
        return detail.structuredContent.messages.some((message) => message.text === sentText)
          ? detail
          : undefined;
      },
      60_000,
    );

    await waitFor(
      "created Gateway session to become idle",
      async () => {
        const listed = await params.gateway.request<{
          sessions?: Array<Record<string, unknown>>;
        }>("sessions.list", {
          archived: false,
          configuredAgentsOnly: true,
          limit: 50,
          search: createdLabel,
        });
        const session = listed.sessions?.find((entry) => entry.key === createdGatewayKey);
        return session?.hasActiveRun === true ? undefined : session;
      },
      60_000,
    );

    const archived = codexSessionUpdateResultSchema.parse(
      await callTool({
        name: "openclaw_session_update",
        arguments: { session_id: created.id, archived: true },
      }),
    ).structuredContent.session;
    assert(archived.archived, "Codex archive did not mark the session archived");
    await waitFor(
      "created session in archived Gateway list",
      async () => {
        const listed = await params.gateway.request<{
          sessions?: Array<Record<string, unknown>>;
        }>("sessions.list", {
          archived: true,
          configuredAgentsOnly: true,
          limit: 50,
          search: createdLabel,
        });
        return listed.sessions?.find((entry) => entry.key === createdGatewayKey);
      },
      60_000,
    );

    const mixedAfterArchive = codexSessionListResultSchema.parse(
      await callTool({ name: "openclaw_sessions_list", arguments: { limit: 10 } }),
    ).structuredContent.items;
    assert(
      requireCodexSession(mixedAfterArchive, createdLabel).archived,
      "default Codex list should retain the newly archived session",
    );
    assert(
      !requireCodexSession(mixedAfterArchive, "Docker MCP Channel Smoke").archived,
      "default Codex list should retain active sessions",
    );

    const archivedOnly = codexSessionListResultSchema.parse(
      await callTool({
        name: "openclaw_sessions_list",
        arguments: { archived: true, limit: 10 },
      }),
    ).structuredContent.items;
    assert(
      requireCodexSession(archivedOnly, createdLabel).archived,
      "explicit archived Codex list missing created session",
    );
    const activeWhileArchived = codexSessionListResultSchema.parse(
      await callTool({
        name: "openclaw_sessions_list",
        arguments: { archived: false, limit: 10 },
      }),
    ).structuredContent.items;
    assert(
      !activeWhileArchived.some((session) => session.id === created.id),
      "archived session remained in explicit active Codex list",
    );

    const restored = codexSessionUpdateResultSchema.parse(
      await callTool({
        name: "openclaw_session_update",
        arguments: { session_id: created.id, archived: false },
      }),
    ).structuredContent.session;
    assert(!restored.archived, "Codex restore did not reactivate the session");
    await waitFor(
      "restored session in active Gateway list",
      async () => {
        const listed = await params.gateway.request<{
          sessions?: Array<Record<string, unknown>>;
        }>("sessions.list", {
          archived: false,
          configuredAgentsOnly: true,
          limit: 50,
          search: createdLabel,
        });
        return listed.sessions?.find((entry) => entry.key === createdGatewayKey);
      },
      60_000,
    );
    const activeAfterRestore = codexSessionListResultSchema.parse(
      await callTool({
        name: "openclaw_sessions_list",
        arguments: { archived: false, limit: 10 },
      }),
    ).structuredContent.items;
    assert(
      !requireCodexSession(activeAfterRestore, createdLabel).archived,
      "restored session missing from explicit active Codex list",
    );

    assertNoRawGatewaySessionKeys(toolResults, [
      "agent:main:main",
      "agent:main:codex-archived",
      createdGatewayKey,
    ]);
    return {
      activeRunAborted: true,
      appResourceLoaded: true,
      defaultActiveArchivedMix: true,
      rawGatewayKeysHidden: true,
      sessionLifecycle: true,
    };
  } finally {
    if (codexHandle) {
      await Promise.allSettled([codexHandle.client.close(), codexHandle.transport.close()]);
    }
    codexTempState.cleanup();
  }
}
