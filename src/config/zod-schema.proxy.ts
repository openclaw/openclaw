import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

export const ProxyConfigSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .url()
      .refine(isHttpUrl, {
        message: "proxyUrl must use http:// or https://",
      })
      .register(sensitive)
      .optional(),
    tls: z
      .strictObject({
        caFile: z.string().min(1).optional(),
      })
      .optional(),
    loopbackMode: z.enum(["gateway-only", "proxy", "block"]).optional(),
  })
  .optional();

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
