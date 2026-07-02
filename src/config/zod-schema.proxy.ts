// Defines proxy-related Zod schema fragments for config parsing.
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

export const ProxyLoopbackModeSchema = z.enum(["gateway-only", "proxy", "block"]);

const ProxyTlsConfigSchema = z
  .object({
    caFile: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const ProxyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .url()
      .refine(isHttpUrl, {
        message: "proxyUrl must use http:// or https://",
      })
      .register(sensitive)
      .optional(),
    tls: ProxyTlsConfigSchema,
    loopbackMode: ProxyLoopbackModeSchema.optional(),
    enhancedNoProxy: z
      .boolean()
      .optional()
      .describe(
        "When true, the global undici dispatcher uses OpenClaw's enhanced " +
          "NO_PROXY matcher, supporting CIDR ranges (10.0.0.0/8) and octet " +
          "wildcards (192.168.*.*) that undici's built-in matcher does not " +
          "handle. Default is false (opt-in). " +
          "Set to false or omit to use undici's native NO_PROXY behavior. " +
          "WARNING: Enabling this affects process-wide egress routing. Deployments " +
          "that rely on the proxy for network access may experience direct connections " +
          "if a broad NO_PROXY pattern is configured. Rollback: disable or remove " +
          "this setting to restore undici's native behavior.",
      ),
  })
  .strict()
  .optional();

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
