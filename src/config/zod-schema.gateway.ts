import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { CONTROL_UI_ENVIRONMENT_COLORS } from "../gateway/control-ui-bootstrap-contract.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
} from "../gateway/operator-scopes.js";
import {
  GatewayRemoteConfigSchema,
  ResponsesEndpointUrlFetchShape,
  validateHttpOrigin,
} from "./zod-schema.root-support.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { sensitive } from "./zod-schema.sensitive.js";

const OperatorScopeSchema = z.enum([
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
]);
const GatewayOperatorRoleDefinitionSchema = z.strictObject({
  sessions: z.strictObject({
    /** Maximum access to another person's sessions without explicit membership. */
    others: z.enum(["none", "view", "suggest", "write"]),
  }),
  /** Require sandbox isolation for newly created sessions, or inherit agent policy by default. */
  sandbox: z.enum(["inherit", "required"]).optional(),
  /** Agent IDs available for session creation and runs, or all agents when set to "*". */
  agents: z.union([
    z.literal("*"),
    z
      .array(z.string().trim().min(1).refine(isValidAgentId, "Invalid agent id"))
      .transform((agents) => uniqueValues(agents.map(normalizeAgentId))),
  ]),
  /** Ceiling applied to the authenticated profile's granted operator scopes. */
  scopes: z.array(OperatorScopeSchema).transform((scopes) => uniqueValues(scopes)),
});
const GatewayOperatorRoleNameSchema = z.string().trim().min(1).max(128);
const GATEWAY_HTTP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validateGatewayPublicOrigin(value: string): boolean {
  if (!validateHttpOrigin(value)) {
    return false;
  }
  const url = new URL(value);
  return url.protocol === "https:" || GATEWAY_HTTP_LOOPBACK_HOSTS.has(url.hostname);
}

export const GatewayConfigSchema = z
  .strictObject({
    /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */
    port: z.number().int().min(1).max(65_535).optional(),
    /**
     * Explicit gateway mode. When set to "remote", local gateway start is disabled.
     * When set to "local", the CLI may start the gateway locally.
     */
    mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
    /**
     * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
     * - auto: Loopback (127.0.0.1) if available, else 0.0.0.0 (fallback to all interfaces)
     * - lan: 0.0.0.0 (all interfaces, no fallback, current BYOH path is IPv4-only)
     * - loopback: 127.0.0.1 (local-only)
     * - tailnet: Tailnet IPv4 plus 127.0.0.1 if available, else loopback only
     * - custom: User-specified IPv4 address (requires customBindHost); specific IPv4s also bind 127.0.0.1
     * IPv6-only BYOH is not natively supported on this path today. Use an IPv4 sidecar or proxy.
     * Default: loopback (127.0.0.1).
     */
    bind: z
      .union([
        z.literal("auto"),
        z.literal("lan"),
        z.literal("loopback"),
        z.literal("custom"),
        z.literal("tailnet"),
      ])
      .optional(),
    /** Custom IPv4 address for bind="custom" mode. IPv6-only BYOH requires an IPv4 sidecar or proxy. */
    customBindHost: z.string().optional(),
    /** Externally reachable HTTPS origin for Gateway callback routes; HTTP only on loopback. */
    publicOrigin: z
      .string()
      .url()
      .refine(
        validateGatewayPublicOrigin,
        "gateway.publicOrigin must be a bare HTTPS origin; HTTP is allowed only for localhost, 127.0.0.1, or [::1]",
      )
      .optional(),
    controlUi: z
      .strictObject({
        // Shipped legacy input. Doctor removes it after recording migration state.
        /**
         * @deprecated Upgrade-only transport input. Retained so releases that shipped
         * this break-glass flag can migrate an unpaired browser safely.
         */
        dangerouslyDisableDeviceAuth: z.boolean().optional(),
        /** If false, the Gateway will not serve the Control UI (default /). */
        enabled: z.boolean().optional(),
        /** Optional base path prefix for the Control UI (e.g. "/openclaw"). */
        basePath: z.string().optional(),
        experimental: z
          .strictObject({
            /** Allow native UI from user-installed plugins (default false; bundled UI stays available). */
            customPlugins: z.boolean().optional(),
          })
          .optional(),
        /** Optional filesystem root for Control UI assets (defaults to dist/control-ui). */
        root: z.string().optional(),
        /** Optional visual label and named color distinguishing this Gateway environment. */
        environment: z
          .strictObject({
            label: z.string().trim().min(1).max(24),
            color: z.enum(CONTROL_UI_ENVIRONMENT_COLORS),
          })
          .optional(),
        /** Show the Discord community invitation in this Gateway's Control UI (default true). */
        communityInvite: z.boolean().optional(),
        /** Optional service credential used only for Control UI GitHub previews and discovery. */
        github: z
          .strictObject({ token: SecretInputSchema.optional().register(sensitive) })
          .optional(),
        /** Produce utility-model session status digests for subscribed Control UI clients (default true). */
        sessionObserver: z.boolean().optional(),
        /**
         * Embed sandbox mode for hosted Control UI previews.
         * - strict: no script execution inside embeds
         * - scripts: allow scripts while keeping embeds origin-isolated (default)
         * - trusted: allow scripts and same-origin privileges
         */
        embedSandbox: z
          .union([z.literal("strict"), z.literal("scripts"), z.literal("trusted")])
          .optional(),
        /**
         * DANGEROUS: Allow hosted embeds to load absolute external http(s) URLs.
         * Default off; prefer hosted /__openclaw__/canvas or /__openclaw__/a2ui content.
         */
        allowExternalEmbedUrls: z.boolean().optional(),
        /** Fetch public-site favicons through the Gateway for Control UI links (default true). */
        automaticallyFetchFavicons: z.boolean().optional(),
        /** Optional max-width for grouped Control UI chat messages (default: min(900px, 68%)). */
        /** Allowed browser origins for Control UI/WebChat websocket connections. */
        allowedOrigins: z.array(z.string()).optional(),
        /**
         * DANGEROUS: Keep Host-header origin fallback behavior.
         * Supported long-term for deployments that intentionally rely on this policy.
         */
        dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
      })
      .optional(),
    cliAgents: z
      .strictObject({
        /** Show catalog-backed CLI agents in the new-session model picker. Default: true. */
        enabled: z.boolean().optional(),
      })
      .optional(),
    terminal: z
      .strictObject({
        /** Master switch for the operator terminal. Default: true; set false to opt out. */
        enabled: z.boolean().optional(),
        /**
         * Shell executable to launch. When unset the host login shell is used
         * ($SHELL on Unix, %ComSpec% on Windows).
         */
        shell: z.string().optional(),
        /**
         * How long (seconds) a session survives after its connection drops, staying
         * reattachable via terminal.attach. 0 kills sessions on disconnect
         * immediately. Default: 300.
         */
        detachedSessionTimeoutSeconds: z.number().int().min(0).optional(),
      })
      .optional(),
    auth: z
      .strictObject({
        /**
         * Authentication mode for Gateway connections. Token/password mode selects the
         * configured secret; clients may send it in either auth.token or auth.password.
         */
        mode: z
          .union([
            z.literal("none"),
            z.literal("token"),
            z.literal("password"),
            z.literal("trusted-proxy"),
          ])
          .optional(),
        /** Shared secret selected by token mode (plaintext or SecretRef). */
        token: SecretInputSchema.optional().register(sensitive),
        /** Shared secret selected by password mode (plaintext or SecretRef; consider env instead). */
        password: SecretInputSchema.optional().register(sensitive),
        /** Allow Tailscale identity headers when serve mode is enabled. */
        allowTailscale: z.boolean().optional(),
        /** Operator scopes granted to verified trusted-proxy or Tailscale identities. */
        identityScopes: z.record(z.string().min(1), z.array(OperatorScopeSchema)).optional(),
        /** Rate-limit configuration for failed authentication attempts. */
        rateLimit: z
          .strictObject({
            /** Maximum failed attempts per IP before blocking.  @default 10 */
            maxAttempts: z.number().optional(),
            /** Sliding window duration in milliseconds.  @default 60000 (1 min) */
            windowMs: z.number().optional(),
            /** Lockout duration in milliseconds after the limit is exceeded.  @default 300000 (5 min) */
            lockoutMs: z.number().optional(),
            /** Exempt localhost/loopback addresses from auth rate limiting.  @default true */
            exemptLoopback: z.boolean().optional(),
          })
          .optional(),
        /**
         * Configuration for trusted-proxy auth mode.
         * Required when mode is "trusted-proxy".
         */
        trustedProxy: z
          .strictObject({
            /**
             * Header name containing the authenticated user identity (required).
             * Common values: "x-forwarded-user", "x-remote-user", "x-pomerium-claim-email"
             */
            userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
            /**
             * Additional headers that MUST be present for the request to be trusted.
             * Use this to verify the request actually came through the proxy.
             * Example: ["x-forwarded-proto", "x-forwarded-host"]
             */
            requiredHeaders: z.array(z.string()).optional(),
            /**
             * Optional allowlist of user identities that can access the gateway.
             * If empty or omitted, all authenticated users from the proxy are allowed.
             * Example: ["nick@example.com", "admin@company.org"]
             */
            allowUsers: z.array(z.string()).optional(),
            /**
             * Allow loopback proxy sources (127.0.0.1, ::1) in trusted-proxy mode.
             * Default false; enable only when a same-host reverse proxy is the intended
             * trust boundary and direct Gateway access is otherwise locked down.
             */
            allowLoopback: z.boolean().optional(),
            /**
             * Automatically approve new browser/native UI operator devices and same-key scope upgrades after
             * trusted-proxy authentication. Disabled by default; configured scopes cap grants.
             */
            deviceAutoApprove: z
              .strictObject({
                /** Enable automatic browser enrollment and same-key scope upgrades. @default false */
                enabled: z.boolean().optional(),
                /**
                 * Maximum operator scopes granted by automatic approval. Listing
                 * operator.admin explicitly lets every proxy-authenticated user request
                 * automatic full-admin device grants. Requests without scopes receive the
                 * configured maximum. @default operator.read, operator.write,
                 * operator.approvals, operator.questions
                 */
                scopes: z.array(z.string().min(1)).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    /** Optional profile-bound operator roles; omitted preserves legacy authorization. */
    roles: z
      .strictObject({
        /** Required validated default for profiles without a valid assigned role. */
        default: GatewayOperatorRoleNameSchema,
        /** Closed capability bundles indexed by administrator-selected role names. */
        definitions: z
          .record(GatewayOperatorRoleNameSchema, GatewayOperatorRoleDefinitionSchema)
          .refine(
            (definitions) => Object.keys(definitions).length > 0,
            "gateway.roles.definitions must contain at least one role definition",
          ),
      })
      .superRefine((roles, ctx) => {
        if (!Object.hasOwn(roles.definitions, roles.default)) {
          ctx.addIssue({
            code: "custom",
            message: "gateway.roles.default must name a configured role definition",
            path: ["default"],
          });
        }
      })
      .optional(),
    /**
     * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
     * arrives from one of these IPs, the Gateway trusts `x-forwarded-for`
     * to determine the client IP for local pairing and HTTP checks.
     */
    trustedProxies: z.array(z.string()).optional(),
    /**
     * Allow `x-real-ip` as a fallback only when `x-forwarded-for` is missing.
     * Default: false (safer fail-closed behavior).
     */
    allowRealIpFallback: z.boolean().optional(),
    /** Tool access restrictions for HTTP /tools/invoke endpoint. */
    tools: z
      .strictObject({
        /** Tools to deny via gateway HTTP /tools/invoke (extends defaults). */
        deny: z.array(z.string()).optional(),
        /** Tools to explicitly allow (removes from default deny list). */
        allow: z.array(z.string()).optional(),
      })
      .optional(),
    tailscale: z
      .strictObject({
        /** Tailscale exposure mode for the Gateway control UI. */
        mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
        /**
         * Detect an external Funnel route left on the ordinary Gateway listener and
         * leave exposure unchanged with migration guidance. Gateway-authenticated
         * routes reject that ingress; plugin-authenticated webhooks keep their owner auth.
         * @deprecated Migrate to `mode="funnel"`, which uses managed ingress.
         */
        preserveFunnel: z.boolean().optional(),
      })
      .optional(),
    remote: GatewayRemoteConfigSchema,
    reload: z
      .strictObject({
        mode: z.union([z.literal("off"), z.literal("hybrid")]).optional(),
      })
      .optional(),
    tls: z
      .object({
        enabled: z.boolean().optional(),
        autoGenerate: z.boolean().optional(),
        // Reject blank values without transforming the string. Trimming here would
        // silently rewrite a legitimate filesystem path that contains leading or
        // trailing spaces and persist the trimmed value into validated config;
        // runtime path resolution (resolveUserPath) owns all normalization.
        certPath: z
          .string()
          .optional()
          .refine((v) => v === undefined || v.trim().length > 0, "certPath must not be blank"),
        keyPath: z
          .string()
          .optional()
          .refine((v) => v === undefined || v.trim().length > 0, "keyPath must not be blank"),
        caPath: z.string().optional(),
      })
      .optional(),
    http: z
      .strictObject({
        endpoints: z
          .strictObject({
            chatCompletions: z
              .strictObject({
                enabled: z.boolean().optional(),
                images: z
                  .strictObject({
                    ...ResponsesEndpointUrlFetchShape,
                  })
                  .optional(),
              })
              .optional(),
            responses: z
              .strictObject({
                enabled: z.boolean().optional(),
                maxUrlParts: z.number().int().nonnegative().optional(),
                files: z
                  .strictObject({
                    ...ResponsesEndpointUrlFetchShape,
                    maxChars: z.number().int().positive().optional(),
                    pdf: z
                      .strictObject({
                        maxPages: z.number().int().positive().optional(),
                        maxPixels: z.number().int().positive().optional(),
                        minTextChars: z.number().int().nonnegative().optional(),
                      })
                      .optional(),
                  })
                  .optional(),
                images: z
                  .strictObject({
                    ...ResponsesEndpointUrlFetchShape,
                  })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
        securityHeaders: z
          .strictObject({
            strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional(),
          })
          .optional(),
      })
      .optional(),
    push: z
      .strictObject({
        apns: z
          .strictObject({
            relay: z
              .strictObject({
                baseUrl: z.string().optional(),
                timeoutMs: z.number().int().positive().optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    nodes: z
      .strictObject({
        /** Browser routing policy for node-hosted browser proxies. */
        browser: z
          .strictObject({
            /** Routing mode (default: auto). */
            mode: z.union([z.literal("auto"), z.literal("manual"), z.literal("off")]).optional(),
            /** Pin to a specific node id/name (optional). */
            node: z.string().optional(),
          })
          .optional(),
        /** Pairing policy for node-role gateway clients. */
        pairing: z
          .strictObject({
            /**
             * Silently approve trusted local device pairing and access upgrades.
             * Set false to require explicit approval; metadata refreshes remain automatic.
             * Default: true.
             */
            autoApproveLocal: z.boolean().optional(),
            /**
             * Opt-in CIDR/IP allowlist for auto-approving first-time node-role pairing.
             * Only applies to fresh node pairing requests with no requested scopes.
             * Default: unset/disabled.
             */
            autoApproveCidrs: z.array(z.string()).optional(),
            /**
             * SSH-verified auto-approval for first-time node-role pairing (default: enabled).
             * The gateway connects back to the pairing host over SSH (BatchMode, strict
             * host keys) and approves only when the remote `openclaw node identity`
             * output matches the pending request's device key. Set false to disable SSH
             * verification; this is independent of autoApproveCidrs, so unset that too for
             * manual-only node pairing. The object form tunes the probe:
             * - user: remote user (default: gateway process user)
             * - identity: SSH identity file (default: standard SSH resolution)
             * - timeoutMs: probe timeout (default: 7000)
             * - cidrs: CIDRs/IPs eligible for probing (default: private/CGNAT ranges)
             */
            sshVerify: z
              .union([
                z.boolean(),
                z.strictObject({
                  user: z.string().optional(),
                  identity: z.string().optional(),
                  timeoutMs: z.number().int().positive().optional(),
                  cidrs: z.array(z.string()).optional(),
                }),
              ])
              .optional(),
          })
          .optional(),
        /** Controls whether paired nodes may publish agent-visible plugin tools (default: true). */
        pluginTools: z
          .strictObject({
            /** Accept node-published plugin tool descriptors (default: true). */
            enabled: z.boolean().optional(),
          })
          .optional(),
        /** Accept node-published skill descriptors (default: true). */
        allowSkills: z.boolean().optional(),
        commands: z
          .strictObject({
            /** Additional node.invoke commands to allow on the gateway. */
            allow: z.array(z.string()).optional(),
            /** Commands to deny even if they appear in the defaults or node claims. */
            deny: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();
