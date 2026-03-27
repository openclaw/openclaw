import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const MCP_DISCOVER_PATH = "/api/aillium/mcp/discover";
const MCP_INVOKE_TOOL_PATH = "/api/aillium/mcp/invoke-tool";
const MCP_READ_RESOURCE_PATH = "/api/aillium/mcp/read-resource";
const MCP_GET_PROMPT_PATH = "/api/aillium/mcp/get-prompt";

const serverSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().optional().nullable(),
    transportType: z.enum(["STDIO", "HTTP"]),
    command: z.string().min(1).optional().nullable(),
    args: z.array(z.string().min(1)).optional(),
    url: z.string().url().optional().nullable(),
    config: z.record(z.unknown()).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.transportType === "STDIO" && !value.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required for stdio MCP servers",
        path: ["command"],
      });
    }
    if (value.transportType === "HTTP" && !value.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url is required for http MCP servers",
        path: ["url"],
      });
    }
  });

const discoverBodySchema = z.object({
  server: serverSchema,
});

const invokeToolBodySchema = z.object({
  server: serverSchema,
  toolName: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
});

const readResourceBodySchema = z.object({
  server: serverSchema,
  uri: z.string().min(1),
});

const getPromptBodySchema = z.object({
  server: serverSchema,
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
});

type AilliumMcpServer = z.infer<typeof serverSchema>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function isAuthorized(req: IncomingMessage): boolean {
  const configured = [
    process.env.AILLIUM_MCP_RUNTIME_TOKEN,
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.MASTER_AGENT_RUNTIME_SYNC_TOKEN,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (configured.length === 0) {
    return false;
  }

  const runtimeToken =
    (typeof req.headers["x-aillium-runtime-token"] === "string"
      ? req.headers["x-aillium-runtime-token"]
      : undefined) ?? "";
  const authorization =
    typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const presented = runtimeToken.trim() || bearerToken;

  return presented.length > 0 && configured.includes(presented);
}

function getEnhancedPath(originalPath: string): string {
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const existing = new Set(originalPath.split(pathSeparator).filter(Boolean));
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const additions =
    process.platform === "darwin"
      ? [
          "/bin",
          "/usr/bin",
          "/usr/local/bin",
          "/opt/homebrew/bin",
          `${homeDir}/.nvm/current/bin`,
          `${homeDir}/.npm-global/bin`,
          `${homeDir}/.yarn/bin`,
          `${homeDir}/.cargo/bin`,
        ]
      : process.platform === "linux"
        ? [
            "/bin",
            "/usr/bin",
            "/usr/local/bin",
            `${homeDir}/.nvm/current/bin`,
            `${homeDir}/.npm-global/bin`,
            `${homeDir}/.yarn/bin`,
            `${homeDir}/.cargo/bin`,
            "/snap/bin",
          ]
        : [`${process.env.APPDATA}\\npm`, `${homeDir}\\.cargo\\bin`];

  for (const value of additions) {
    if (value && !existing.has(value)) {
      existing.add(value);
    }
  }

  return [...existing].join(pathSeparator);
}

async function withMcpClient<T>(
  server: AilliumMcpServer,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    {
      name: `aillium-${server.name}`,
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  if (server.transportType === "STDIO") {
    const config = (server.config ?? {}) as Record<string, unknown>;
    const env =
      config.env && typeof config.env === "object"
        ? Object.fromEntries(
            Object.entries(config.env as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value ?? ""),
            ]),
          )
        : {};
    const cwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd : undefined;
    const command =
      process.platform === "win32" && server.command === "npx"
        ? "npx.cmd"
        : process.platform === "win32" && server.command === "node"
          ? "node.exe"
          : (server.command as string);
    const transport = new StdioClientTransport({
      command,
      args: server.args ?? [],
      stderr: process.platform === "win32" ? "pipe" : "inherit",
      env: {
        ...process.env,
        PATH: getEnhancedPath(process.env.PATH || ""),
        ...env,
      },
      ...(cwd ? { cwd } : {}),
    });
    await client.connect(transport);
  } else {
    const config = (server.config ?? {}) as Record<string, unknown>;
    const headers =
      config.headers && typeof config.headers === "object"
        ? Object.fromEntries(
            Object.entries(config.headers as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value ?? ""),
            ]),
          )
        : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(server.url as string), {
      requestInit: headers ? { headers } : undefined,
    });
    await client.connect(transport);
  }

  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function discoverServer(server: AilliumMcpServer) {
  try {
    return await withMcpClient(server, async (client) => {
      const [tools, resources, prompts] = await Promise.allSettled([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);

      const degraded = [tools, resources, prompts].some((entry) => entry.status === "rejected");
      const rejected = [tools, resources, prompts]
        .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
        .map((entry) => String(entry.reason));

      return {
        healthStatus: degraded ? "DEGRADED" : "HEALTHY",
        lastError: rejected[0] ?? null,
        catalog: {
          tools: tools.status === "fulfilled" ? tools.value.tools ?? [] : [],
          resources: resources.status === "fulfilled" ? resources.value.resources ?? [] : [],
          prompts: prompts.status === "fulfilled" ? prompts.value.prompts ?? [] : [],
        },
      };
    });
  } catch (error) {
    return {
      healthStatus: "UNREACHABLE",
      lastError: String(error),
      catalog: {
        tools: [],
        resources: [],
        prompts: [],
      },
    };
  }
}

async function invokeTool(input: z.infer<typeof invokeToolBodySchema>) {
  return await withMcpClient(input.server, async (client) => ({
    result: await client.callTool({
      name: input.toolName,
      arguments: input.arguments ?? {},
    }),
  }));
}

async function readResource(input: z.infer<typeof readResourceBodySchema>) {
  return await withMcpClient(input.server, async (client) => ({
    result: await client.readResource(
      {
        uri: input.uri,
      },
      {},
    ),
  }));
}

async function getPrompt(input: z.infer<typeof getPromptBodySchema>) {
  return await withMcpClient(input.server, async (client) => ({
    result: await client.getPrompt({
      name: input.name,
      arguments: input.arguments ?? {},
    }),
  }));
}

export async function handleAilliumMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
): Promise<boolean> {
  if (
    requestPath !== MCP_DISCOVER_PATH &&
    requestPath !== MCP_INVOKE_TOOL_PATH &&
    requestPath !== MCP_READ_RESOURCE_PATH &&
    requestPath !== MCP_GET_PROMPT_PATH
  ) {
    return false;
  }

  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  try {
    const body = await readJsonBody(req);
    if (requestPath === MCP_DISCOVER_PATH) {
      const parsed = discoverBodySchema.parse(body);
      sendJson(res, 200, await discoverServer(parsed.server));
      return true;
    }

    if (requestPath === MCP_READ_RESOURCE_PATH) {
      const parsed = readResourceBodySchema.parse(body);
      sendJson(res, 200, await readResource(parsed));
      return true;
    }

    if (requestPath === MCP_GET_PROMPT_PATH) {
      const parsed = getPromptBodySchema.parse(body);
      sendJson(res, 200, await getPrompt(parsed));
      return true;
    }

    const parsed = invokeToolBodySchema.parse(body);
    sendJson(res, 200, await invokeTool(parsed));
    return true;
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Invalid MCP request",
    });
    return true;
  }
}
