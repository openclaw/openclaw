import { Type } from "@sinclair/typebox";

import { getTailnetHostname } from "../../infra/tailscale.js";
import {
  serveCreate,
  serveDelete,
  serveList,
} from "../../gateway/serve.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

async function resolveServeBaseUrl(providedUrl?: string): Promise<string> {
  if (providedUrl) return providedUrl;
  try {
    const tailnetHost = await getTailnetHostname();
    return `https://${tailnetHost}`;
  } catch {
    return "http://localhost:18789";
  }
}

export function createServeTool(opts?: { baseUrl?: string }): AnyAgentTool {
  return {
    label: "Serve File",
    name: "serve",
    description:
      "Create a publicly accessible URL for a file. Returns a URL that can be shared. " +
      "Supports optional title, description, and OG image for rich link previews. " +
      "TTL can be specified as a duration (e.g., '1h', '7d') or 'forever'.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the file to serve" }),
      slug: Type.Optional(
        Type.String({ description: "Custom URL slug (auto-generated if omitted)" }),
      ),
      title: Type.Optional(
        Type.String({ description: "Title for link preview" }),
      ),
      description: Type.Optional(
        Type.String({ description: "Description for link preview" }),
      ),
      ttl: Type.Optional(
        Type.String({
          description: "Time to live: '1h', '7d', 'forever' (default: '24h')",
        }),
      ),
      ogImage: Type.Optional(
        Type.String({ description: "URL or path to Open Graph preview image" }),
      ),
    }),
    execute: async (_toolCallId: string, args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const filePath = readStringParam(params, "path", { required: true });
      const slug = readStringParam(params, "slug");
      const title = readStringParam(params, "title");
      const description = readStringParam(params, "description");
      const ttl = readStringParam(params, "ttl");
      const ogImage = readStringParam(params, "ogImage");

      const baseUrl = await resolveServeBaseUrl(opts?.baseUrl);
      const result = serveCreate(
        { path: filePath, slug: slug || "file", title: title || "", description: description || "", ttl, ogImage },
        baseUrl,
      );
      return jsonResult(result);
    },
  };
}

export function createServeListTool(opts?: { baseUrl?: string }): AnyAgentTool {
  return {
    label: "List Served Files",
    name: "serve_list",
    description: "List all currently served files with their URLs and metadata.",
    parameters: Type.Object({}),
    execute: async () => {
      const baseUrl = await resolveServeBaseUrl(opts?.baseUrl);
      const items = serveList(baseUrl);
      return jsonResult({ count: items.length, items });
    },
  };
}

export function createServeDeleteTool(): AnyAgentTool {
  return {
    label: "Delete Served File",
    name: "serve_delete",
    description: "Remove a served file by its slug.",
    parameters: Type.Object({
      slug: Type.String({ description: "The slug of the served file to delete" }),
    }),
    execute: async (_toolCallId: string, args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const slug = readStringParam(params, "slug", { required: true });
      const deleted = serveDelete(slug);
      return jsonResult({ deleted, slug });
    },
  };
}
