// Defines the MCP server config Zod schema.
import { isHttpsUrl, isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

const HttpUrlSchema = z.string().url().refine(isHttpUrl, "Expected http:// or https:// URL");

const McpOAuthClientMetadataUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return isHttpsUrl(url) && url.pathname !== "/";
  }, "Expected https:// URL with a non-root pathname");

export const McpServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    cwd: z.string().optional(),
    workingDirectory: z.string().optional(),
    url: HttpUrlSchema.optional(),
    transport: z
      .union([z.literal("stdio"), z.literal("sse"), z.literal("streamable-http")])
      .optional(),
    headers: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    connectionTimeoutMs: z.number().finite().positive().optional(),
    connectTimeout: z.number().finite().positive().optional(),
    connect_timeout: z.number().finite().positive().optional(),
    requestTimeoutMs: z.number().finite().positive().optional(),
    timeout: z.number().finite().positive().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    supports_parallel_tool_calls: z.boolean().optional(),
    auth: z.literal("oauth").optional(),
    oauth: z
      .strictObject({
        authProfileId: z.string().trim().min(1).optional(),
        scope: z.string().trim().min(1).optional(),
        redirectUrl: HttpUrlSchema.optional(),
        clientMetadataUrl: McpOAuthClientMetadataUrlSchema.optional(),
      })
      .optional(),
    sslVerify: z.boolean().optional(),
    ssl_verify: z.boolean().optional(),
    clientCert: z.string().optional(),
    client_cert: z.string().optional(),
    clientKey: z.string().optional(),
    client_key: z.string().optional(),
    toolFilter: z
      .strictObject({
        include: z.array(z.string().trim().min(1)).min(1).optional(),
        exclude: z.array(z.string().trim().min(1)).min(1).optional(),
      })
      .optional(),
    codex: z
      .strictObject({
        agents: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
          )
          .min(1)
          .optional(),
        defaultToolsApprovalMode: z.enum(["auto", "prompt", "approve"]).optional(),
        default_tools_approval_mode: z.enum(["auto", "prompt", "approve"]).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // transport "stdio" requires a non-empty command — URL-only servers must use "sse" or "streamable-http"
    if (
      data.transport === "stdio" &&
      (typeof data.command !== "string" || data.command.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"stdio" transport requires a non-empty command',
        path: ["transport"],
      });
    }
    // `disabled` is not a supported MCP server field; the canonical field is `enabled`.
    if ("disabled" in data) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'MCP server field "disabled" is not supported; use "enabled: false" to disable a server',
        path: ["disabled"],
      });
    }
  })
  .catchall(z.unknown());
