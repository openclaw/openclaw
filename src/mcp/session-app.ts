// MCP app assembly owns the explicit HTML resource and server presentation metadata.
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { root } from "../infra/fs-safe.js";
import { VERSION } from "../version.js";
import type { SessionCapabilities } from "./session-tools.js";

export const OPENCLAW_SESSION_APP_URI = "ui://openclaw/session";
export const OPENCLAW_SESSION_APP_MIME_TYPE = "text/html;profile=mcp-app";
const MAX_APP_RESOURCE_BYTES = 1024 * 1024;

const OPENCLAW_OUTLINE_LIGHT_SVG = `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g stroke="#242424" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"/>
    <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"/>
    <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"/>
    <path d="M45 15 Q35 5 30 8" stroke-width="5"/>
    <path d="M75 15 Q85 5 90 8" stroke-width="5"/>
  </g>
  <circle cx="45" cy="35" r="5.5" fill="#242424"/>
  <circle cx="75" cy="35" r="5.5" fill="#242424"/>
</svg>`;

const OPENCLAW_OUTLINE_DARK_SVG = `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g stroke="#f3f3f3" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"/>
    <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"/>
    <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"/>
    <path d="M45 15 Q35 5 30 8" stroke-width="5"/>
    <path d="M75 15 Q85 5 90 8" stroke-width="5"/>
  </g>
  <circle cx="45" cy="35" r="5.5" fill="#f3f3f3"/>
  <circle cx="75" cy="35" r="5.5" fill="#f3f3f3"/>
</svg>`;

/** Build server info without depending on a plugin install directory at runtime. */
export function openClawMcpServerInfo(): Implementation {
  return {
    name: "openclaw",
    title: "OpenClaw",
    version: VERSION,
    websiteUrl: "https://openclaw.ai/",
    description: "OpenClaw Gateway sessions and channel conversations.",
    icons: [
      {
        src: svgDataUrl(OPENCLAW_OUTLINE_LIGHT_SVG),
        mimeType: "image/svg+xml",
        sizes: ["120x120"],
        theme: "light",
      },
      {
        src: svgDataUrl(OPENCLAW_OUTLINE_DARK_SVG),
        mimeType: "image/svg+xml",
        sizes: ["120x120"],
        theme: "dark",
      },
    ],
  };
}

/** Read the one explicitly configured app resource under the plugin cwd. */
export async function loadOpenClawMcpAppResource(params: {
  cwd: string;
  resourcePath: string;
}): Promise<string> {
  const pluginRoot = path.resolve(params.cwd);
  const requestedPath = path.resolve(pluginRoot, params.resourcePath);
  const relativePath = path.relative(pluginRoot, requestedPath);
  const escapesRoot =
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  if (escapesRoot) {
    throw new Error("MCP app resource must stay within the plugin root");
  }
  const pluginFiles = await root(pluginRoot);
  const resource = await pluginFiles.read(relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_APP_RESOURCE_BYTES,
    symlinks: "follow-within-root",
  });
  return resource.buffer.toString("utf8");
}

/** Register the fallback global entrypoint and its single MCP App resource. */
export function registerOpenClawMcpApp(
  server: McpServer,
  params: {
    html: string;
    open: () => Promise<{
      items: unknown[];
      agents: unknown[];
      capabilities: SessionCapabilities;
    }>;
  },
): void {
  const resourceMeta = { ui: { prefersBorder: false } };
  server.registerResource(
    "OpenClaw session app",
    OPENCLAW_SESSION_APP_URI,
    {
      title: "OpenClaw",
      description: "OpenClaw session browser and chat interface.",
      mimeType: OPENCLAW_SESSION_APP_MIME_TYPE,
      _meta: resourceMeta,
    },
    async () => ({
      contents: [
        {
          uri: OPENCLAW_SESSION_APP_URI,
          mimeType: OPENCLAW_SESSION_APP_MIME_TYPE,
          text: params.html,
          _meta: resourceMeta,
        },
      ],
    }),
  );
  server.registerTool(
    "openclaw",
    {
      title: "OpenClaw",
      description: "Open the OpenClaw session browser.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        "openai/ui": { entrypoints: [{ type: "global" }] },
        ui: { resourceUri: OPENCLAW_SESSION_APP_URI, visibility: ["app"] },
      },
    },
    async () => {
      try {
        return {
          content: [{ type: "text" as const, text: "OpenClaw" }],
          structuredContent: await params.open(),
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: "OpenClaw request unavailable." }],
          structuredContent: { error: { code: "gateway_unavailable" } },
          isError: true,
        };
      }
    },
  );
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
