import { isHttpsUrl, isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

const HttpUrlSchema = z.string().url().refine(isHttpUrl, "Expected http:// or https:// URL");
const EnterpriseIssuerSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = URL.parse(value);
    return url !== null && isHttpsUrl(url);
  }, "Expected https:// URL");
const EnterpriseClientIdSchema = z.string().trim().min(1);
const EnterpriseClientSecretSchema = z.string().min(1).register(sensitive);

const McpOAuthClientMetadataUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = URL.parse(value);
    return url !== null && isHttpsUrl(url) && url.pathname !== "/";
  }, "Expected https:// URL with a non-root pathname");

function createMcpSensitiveRecordSchema() {
  return z
    .record(
      z.string(),
      z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
    )
    .optional();
}

export const McpServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: createMcpSensitiveRecordSchema(),
    cwd: z.string().optional(),
    url: HttpUrlSchema.optional(),
    transport: z
      .union([z.literal("stdio"), z.literal("sse"), z.literal("streamable-http")])
      .optional(),
    headers: createMcpSensitiveRecordSchema(),
    connectionTimeoutMs: z.number().finite().positive().optional(),
    requestTimeoutMs: z.number().finite().positive().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    auth: z.enum(["oauth", "enterprise"]).optional(),
    oauth: z
      .strictObject({
        identity: z.enum(["shared", "per-requester"]).optional(),
        authProfileId: z.string().trim().min(1).optional(),
        scope: z.string().trim().min(1).optional(),
        redirectUrl: HttpUrlSchema.optional(),
        clientMetadataUrl: McpOAuthClientMetadataUrlSchema.optional(),
      })
      .optional(),
    enterprise: z
      .strictObject({
        identity: z.literal("shared"),
        idpIssuer: EnterpriseIssuerSchema,
        idpClientId: EnterpriseClientIdSchema,
        idpClientSecret: EnterpriseClientSecretSchema,
        resourceIssuer: EnterpriseIssuerSchema,
        resourceClientId: EnterpriseClientIdSchema,
        resourceClientSecret: EnterpriseClientSecretSchema,
        scope: z.string().trim().min(1),
        redirectUrl: z
          .string()
          .url()
          .refine((value) => {
            const url = URL.parse(value);
            return (
              url !== null &&
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
              !url.username &&
              !url.password
            );
          }, "Expected an HTTP loopback callback URL"),
        tokenEndpointAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
      })
      .optional(),
    sslVerify: z.boolean().optional(),
    clientCert: z.string().optional(),
    clientKey: z.string().optional(),
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
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // This schema is .catchall(z.unknown()) (open-world server options), so
    // unknown keys survive into this refine; retired aliases are rejected here.
    for (const key of [
      "connectTimeout",
      "connect_timeout",
      "timeout",
      "workingDirectory",
      "supports_parallel_tool_calls",
      "ssl_verify",
      "client_cert",
      "client_key",
    ] as const) {
      if (Object.hasOwn(data, key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unrecognized key: "${key}"`,
        });
      }
    }
    const codex = data.codex;
    if (codex && Object.hasOwn(codex, "default_tools_approval_mode")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codex", "default_tools_approval_mode"],
        message: 'Unrecognized key: "default_tools_approval_mode"',
      });
    }
    if (Object.hasOwn(data, "disabled")) {
      const disabled = Reflect.get(data, "disabled") as unknown;
      const replacement =
        typeof disabled === "boolean"
          ? `"enabled: ${!disabled}" instead, then run "openclaw doctor --fix" to migrate existing config`
          : 'the "enabled" boolean instead';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unsupported key "disabled"; use ${replacement}`,
        path: ["disabled"],
      });
    }
    if (data.oauth?.identity === "per-requester") {
      if (data.auth !== "oauth") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.identity "per-requester" requires auth: "oauth"',
          path: ["oauth", "identity"],
        });
      }
      if (data.oauth.authProfileId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.authProfileId cannot be used with oauth.identity "per-requester"',
          path: ["oauth", "authProfileId"],
        });
      }
      if (!data.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.identity "per-requester" requires an HTTP server URL',
          path: ["oauth", "identity"],
        });
      }
      // Command precedence would resolve stdio and strand the server: partitioned
      // out of the static runtime with no requester sign-in path.
      if (data.command !== undefined || data.transport === "stdio") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'oauth.identity "per-requester" cannot be combined with a command or "stdio" transport',
          path: ["oauth", "identity"],
        });
      }
    }
    if (data.auth === "enterprise") {
      if (
        !data.enterprise ||
        !data.url ||
        data.command !== undefined ||
        data.transport === "stdio"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'auth: "enterprise" requires enterprise settings and an HTTP server URL',
          path: ["enterprise"],
        });
      }
      if (data.oauth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'auth: "enterprise" cannot be combined with oauth settings',
          path: ["oauth"],
        });
      }
    } else if (data.enterprise) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'enterprise settings require auth: "enterprise"',
        path: ["enterprise"],
      });
    }
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
  })
  .catchall(z.unknown());

export type McpServerConfigInput = z.input<typeof McpServerSchema>;
