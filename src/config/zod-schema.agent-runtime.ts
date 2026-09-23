// Defines Zod schema fragments for per-agent runtime configuration.
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { getBlockedNetworkModeReason } from "../agents/sandbox/network-mode.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  resolveExactExecModeFromPolicy,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals-core.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { MANAGED_GITHUB_PROFILE_ID_PATTERN } from "./github-identity-profile-id.js";
import { LEGACY_WEB_SEARCH_PROVIDER_CONFIG_KEYS } from "./web-search-legacy-provider-keys.js";
import { AgentEntryBaseSchema } from "./zod-schema.agent-entry-base.js";
import { AgentModelSchema } from "./zod-schema.agent-model.js";
import {
  GroupChatSchema,
  HumanDelaySchema,
  IdentitySchema,
  SecretInputSchema,
  SsrFPolicyConfigSchema,
  ToolsLinksSchema,
  ToolsMediaSchema,
  TypingModeSchema,
  TtsConfigSchema,
} from "./zod-schema.core.js";
import { MemorySearchSchema } from "./zod-schema.memory-search.js";
import {
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./zod-schema.sandbox.js";
import { sensitive } from "./zod-schema.sensitive.js";

const AgentTtsConfigSchema = TtsConfigSchema.unwrap()
  .extend({ prefsPath: z.string().optional() })
  .strict()
  .optional();

export const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    activeHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    target: z.string().optional(),
    directPolicy: z.union([z.literal("allow"), z.literal("block")]).optional(),
    to: z.string().optional(),
    accountId: z.string().optional(),
    prompt: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    lightContext: z.boolean().optional(),
    isolatedSession: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.every) {
      try {
        parseDurationMs(val.every, { defaultUnit: "m" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["every"],
          message: "invalid duration (use ms, s, m, h)",
        });
      }
    }

    const active = val.activeHours;
    if (!active) {
      return;
    }
    const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
    const validateTime = (raw: string | undefined, opts: { allow24: boolean }, path: string) => {
      if (!raw) {
        return;
      }
      if (!timePattern.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: 'invalid time (use "HH:MM" 24h format)',
        });
        return;
      }
      const [hourStr, minuteStr] = raw.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      if (hour === 24 && minute !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (24:00 is the only allowed 24:xx value)",
        });
        return;
      }
      if (hour === 24 && !opts.allow24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (start cannot be 24:00)",
        });
      }
    };

    validateTime(active.start, { allow24: false }, "start");
    validateTime(active.end, { allow24: true }, "end");
  })
  .optional();

export const AgentContextLimitsSchema = z
  .object({
    /** Default max chars returned by memory_get before truncation metadata/notice (default: 12000). */
    memoryGetMaxChars: z.number().int().min(1).max(250_000).optional(),
    /** Max chars retained from post-compaction AGENTS.md context injection (default: 1800). */
    postCompactionMaxChars: z.number().int().min(1).max(50_000).optional(),
  })
  .strict()
  .optional();

const AgentSkillsLimitsSchema = z
  .object({
    maxSkillsPromptChars: z.number().int().min(0).optional(),
  })
  .strict()
  .optional();

const ToolPolicyBaseSchema = z
  .object({
    /** Exact tool names allowed in this policy scope. */
    allow: z.array(z.string()).optional(),
    /** Additional allowlist entries merged into the inherited policy. */
    alsoAllow: z.array(z.string()).optional(),
    /** Exact tool names denied after allow expansion; deny wins. */
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const ToolPolicySchema = ToolPolicyBaseSchema.superRefine((value, ctx) => {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    });
  }
}).optional();

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const TrimmedOptionalConfigStringSchema = z
  .string()
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  .optional();

const CodexAllowedDomainsSchema = z
  .array(z.string())
  .transform((values) => {
    const deduped = uniqueStrings(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    );
    return deduped.length > 0 ? deduped : undefined;
  })
  .optional();

const CodexUserLocationSchema = z
  .object({
    country: TrimmedOptionalConfigStringSchema,
    region: TrimmedOptionalConfigStringSchema,
    city: TrimmedOptionalConfigStringSchema,
    timezone: TrimmedOptionalConfigStringSchema,
  })
  .strict()
  .transform((value) => {
    return value.country || value.region || value.city || value.timezone ? value : undefined;
  })
  .optional();

const BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD = "__openclawBlockedWebSearchKeys";

const ToolsWebSearchSchema = z
  .preprocess(
    (value) => {
      if (!isPlainRecord(value)) {
        return value;
      }
      const blockedKeys = Object.getOwnPropertyNames(value).filter((key) =>
        isBlockedObjectKey(key),
      );
      if (blockedKeys.length === 0) {
        return value;
      }
      return {
        ...value,
        [BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD]: blockedKeys,
      };
    },
    z
      .object({
        enabled: z.boolean().optional(),
        provider: z.string().optional(),
        maxResults: z.number().int().positive().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
        cacheTtlMinutes: z.number().nonnegative().optional(),
        openaiCodex: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.union([z.literal("cached"), z.literal("live")]).optional(),
            allowedDomains: CodexAllowedDomainsSchema,
            contextSize: z
              .union([z.literal("low"), z.literal("medium"), z.literal("high")])
              .optional(),
            userLocation: CodexUserLocationSchema,
          })
          .strict()
          .optional(),
      })
      .catchall(z.unknown())
      .superRefine((value, ctx) => {
        const blockedKeys = value[BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD];
        if (Array.isArray(blockedKeys)) {
          for (const key of blockedKeys) {
            if (typeof key !== "string") {
              continue;
            }
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "tools.web.search must not contain blocked object keys",
            });
          }
        }
        for (const [key, entry] of Object.entries(value)) {
          if (key === BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD || isBlockedObjectKey(key)) {
            continue;
          }
          if (
            key === "apiKey" ||
            (LEGACY_WEB_SEARCH_PROVIDER_CONFIG_KEYS.has(key) && isPlainRecord(entry))
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message:
                "legacy web_search provider config must use plugins.entries.<plugin>.config.webSearch",
            });
          }
        }
      }),
  )
  .optional();

const ToolsWebFetchSchema = z
  .object({
    /** Enable web fetch tool (default: true). */
    enabled: z.boolean().optional(),
    /** Web fetch fallback provider id. */
    provider: z.string().optional(),
    /** Max characters to return from fetched content. */
    maxChars: z.number().int().positive().optional(),
    /** Hard cap for maxChars (tool or config), defaults to 20000. */
    maxCharsCap: z.number().int().positive().optional(),
    /** Max download size before truncation, defaults to 750000 bytes. */
    maxResponseBytes: z.number().int().positive().optional(),
    /** Timeout in seconds for fetch requests. */
    timeoutSeconds: z.number().int().positive().optional(),
    /** Cache TTL in minutes for fetched content. */
    cacheTtlMinutes: z.number().nonnegative().optional(),
    /** Maximum number of redirects to follow (default: 3). */
    maxRedirects: z.number().int().nonnegative().optional(),
    /** Override User-Agent header for fetch requests. */
    userAgent: z.string().optional(),
    // Values are registered sensitive so exposed config redacts them. Names are
    // validated at request time rather than here, because a fail-closed config
    // error over one header typo would disable the whole surface.
    /**
     * Extra request headers sent with direct web_fetch requests. Every value is
     * treated as sensitive in exposed config. Entries a request cannot carry are
     * dropped with a warning at request time.
     */
    headers: z.record(z.string(), z.string().register(sensitive)).optional(),
    /** Use Readability to extract main content (default: true). */
    readability: z.boolean().optional(),
    /** Route web_fetch through a trusted HTTP(S) env proxy and let the proxy resolve DNS. Enable only when that proxy enforces outbound policy. */
    useTrustedEnvProxy: z.boolean().optional(),
    /** SSRF policy configuration for web_fetch. */
    ssrfPolicy: SsrFPolicyConfigSchema.optional(),
  })
  .strict()
  .optional();

const ToolsWebSchema = z
  .object({
    search: ToolsWebSearchSchema,
    fetch: ToolsWebFetchSchema,
  })
  .strict()
  .optional();

const ToolProfileSchema = z
  .union([z.literal("minimal"), z.literal("coding"), z.literal("messaging"), z.literal("full")])
  .optional();

type AllowlistPolicy = {
  allow?: string[];
  alsoAllow?: string[];
};

function addAllowAlsoAllowConflictIssue(
  value: AllowlistPolicy,
  ctx: z.RefinementCtx,
  message: string,
): void {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    });
  }
}

const ToolPolicyWithProfileSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    profile: ToolProfileSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  });

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
export const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

const ToolExecApplyPatchSchema = z
  .object({
    /** Enable apply_patch for OpenAI models (default: true; set false to disable). */
    enabled: z.boolean().optional(),
    /**
     * Restrict apply_patch paths to the workspace directory.
     * Default: true (safer; does not affect read/write/edit).
     */
    workspaceOnly: z.boolean().optional(),
    /**
     * Optional allowlist of model ids that can use apply_patch.
     * Accepts either raw ids (e.g. "gpt-5.4") or full ids (e.g. "openai/gpt-5.4").
     */
    allowModels: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const ToolExecSafeBinProfileSchema = z
  .object({
    minPositional: z.number().int().nonnegative().optional(),
    maxPositional: z.number().int().nonnegative().optional(),
    allowedValueFlags: z.array(z.string()).optional(),
    deniedFlags: z.array(z.string()).optional(),
  })
  .strict();

const ToolExecBaseShape = {
  /** Exec host routing (default: auto). */
  host: z.enum(["auto", "sandbox", "gateway", "node"]).optional(),
  /** Normalized exec policy mode. Prefer this over raw security/ask knobs. */
  mode: z.enum(["deny", "allowlist", "ask", "auto", "full"]).optional(),
  /** Legacy exec security mode retained when no canonical mode can preserve policy. */
  security: z.enum(["deny", "allowlist", "full"]).optional(),
  /** Legacy exec ask mode retained when no canonical mode can preserve policy. */
  ask: z.enum(["off", "on-miss", "always"]).optional(),
  /** Default node binding for exec.host=node (node id/name). */
  node: z.string().optional(),
  /** Directories to prepend to PATH when running exec (gateway/sandbox). */
  pathPrepend: z.array(z.string()).optional(),
  /** Safe stdin-only binaries that can run without allowlist entries. */
  safeBins: z.array(z.string()).optional(),
  /**
   * Require explicit approval for interpreter inline-eval forms (`python -c`, `node -e`, etc.).
   * Prevents silent allowlist reuse and allow-always persistence for those forms.
   */
  strictInlineEval: z.boolean().optional(),
  /** Render parser-derived command highlights in exec approval prompts (default: false). */
  commandHighlighting: z.boolean().optional(),
  /**
   * Default lifetime, in days, stamped onto standing grants minted by
   * allow-always on automation approvals. Unset means grants live until
   * revoked or the owning job changes. Terms freeze at mint; changing this
   * affects only future grants.
   */
  grantExpiryDays: z.number().int().min(1).max(3650).optional(),
  /** Extra explicit directories trusted for safeBins path checks (never derived from PATH). */
  safeBinTrustedDirs: z.array(z.string()).optional(),
  /** Optional custom safe-bin profiles for entries in tools.exec.safeBins. */
  safeBinProfiles: z.record(z.string(), ToolExecSafeBinProfileSchema).optional(),
  /** Model-backed reviewer used by tools.exec.mode=auto before falling back to human approval. */
  reviewer: z
    .object({
      /** Optional reviewer model override (provider/model or agent model config). */
      model: AgentModelSchema.optional(),
      /** Optional reasoning effort for model-backed approval reviews. */
      thinking: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      /** Optional Fast processing for supported provider requests. */
      fastMode: z.boolean().optional(),
      /** Reviewer timeout in milliseconds (default: 30000). */
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
  /** Default time (ms) before an exec command auto-backgrounds. */
  backgroundMs: z.number().int().positive().optional(),
  // The documented global setting and per-agent override share one strict contract.
  /** Emit a running notice (ms) when approval-backed exec runs long (default: 10000, 0 = off). */
  approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
  /** Default timeout (seconds) before auto-killing exec commands. */
  timeoutSeconds: z.number().int().positive().optional(),
  /** How long to keep finished sessions in memory (ms). */
  cleanupMs: z.number().int().positive().optional(),
  /** Emit a system event and heartbeat when a backgrounded exec exits. */
  notifyOnExit: z.boolean().optional(),
  /**
   * Also emit success exit notifications when a backgrounded exec has no output.
   * Default false to reduce context noise.
   */
  notifyOnExitEmptySuccess: z.boolean().optional(),
  /** apply_patch subtool configuration. */
  applyPatch: ToolExecApplyPatchSchema,
} as const;

function addExecPolicyModeConflictIssue(
  value: { mode?: unknown; security?: ExecSecurity; ask?: ExecAsk },
  ctx: z.RefinementCtx,
): void {
  if (value.mode === undefined || (value.security === undefined && value.ask === undefined)) {
    return;
  }
  // The issue path identifies root or agent scope; repair that same object without
  // inferring missing policy values or using the lossy display-mode projection.
  const exactMode =
    value.security !== undefined && value.ask !== undefined
      ? resolveExactExecModeFromPolicy({ security: value.security, ask: value.ask })
      : null;
  const repair = exactMode
    ? `Replace security/ask with mode="${exactMode}" (the equivalent of security="${value.security}" + ask="${value.ask}").`
    : value.security !== undefined && value.ask !== undefined
      ? "This security/ask pair has no exact mode equivalent. To keep this policy, retain both legacy fields and remove mode."
      : "The legacy policy is incomplete. Choose the intended security and ask values before converting; no mode equivalent can be inferred.";
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["mode"],
    message: `mode cannot be combined with security or ask in the same exec object. Update the deploy script, template, or patch at this scope. ${repair} Doctor migrates supported legacy policies to mode; run "openclaw doctor --fix" only when the saved file still needs migration.`,
  });
}

const ToolExecSchema = z
  .object(ToolExecBaseShape)
  .strict()
  .superRefine(addExecPolicyModeConflictIssue)
  .optional();

const ToolFsSchema = z
  .object({
    /**
     * Restrict filesystem tools (read/write/edit/apply_patch) to the agent workspace directory.
     * Default: false (unrestricted, matches legacy behavior).
     */
    workspaceOnly: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolLoopDetectionSchema = z
  .object({
    /** Enable tool-loop protection (default: false). */
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolSearchSchema = z
  .union([
    z.boolean(),
    z
      .object({
        /** Enable compact search/call cataloging for large tool sets. */
        enabled: z.boolean().optional(),
        /** Exposed model surface. "code" exposes tool_search_code; "tools" exposes structured fallback tools; "directory" keeps a bounded directory plus selected schemas visible while deferring the rest behind search/describe/call. */
        mode: z.enum(["code", "tools", "directory"]).optional(),
        /** Timeout in milliseconds for one tool_search_code execution. Runtime clamps to 1s..60s. */
        codeTimeoutMs: z.number().int().positive().optional(),
        /** Default search result count when the model omits a limit. Runtime clamps to maxSearchLimit. */
        searchDefaultLimit: z.number().int().positive().optional(),
        /** Maximum search result count. Runtime clamps to 1..50. */
        maxSearchLimit: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .optional();

const CodeModeSchema = z
  .union([
    z.boolean(),
    z.literal("auto"),
    z
      .object({
        /** Explicit object-form activation. Omitted stays off; "auto" engages catalog-preferred models. A completely absent global codeMode setting defaults separately to auto. */
        enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
        /** Executor. Node is the default; QuickJS provides a separate WASM guest. */
        executor: z.enum(["node", "quickjs"]).optional(),
        /** Model-facing mode. Only "only" is supported: expose exec/wait and hide normal tools. */
        mode: z.literal("only").optional(),
        /** Wall-clock limit in milliseconds for one exec or wait call. */
        timeoutMs: z.number().int().positive().optional(),
        /** QuickJS guest heap limit or best-effort Node worker V8 heap budget in bytes; excludes external buffers and process RSS. */
        memoryLimitBytes: z.number().int().positive().optional(),
        /** Maximum serialized output bytes. */
        maxOutputBytes: z.number().int().positive().optional(),
        /** Maximum serialized snapshot bytes. */
        maxSnapshotBytes: z.number().int().positive().optional(),
        /** Maximum concurrent nested tool calls. */
        maxPendingToolCalls: z.number().int().positive().optional(),
        /** Retention for suspended snapshots. */
        snapshotTtlSeconds: z.number().int().positive().optional(),
        /** Default search result count for catalog.search. */
        searchDefaultLimit: z.number().int().positive().optional(),
        /** Maximum search result count for catalog.search. */
        maxSearchLimit: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .optional();

const SwarmSchema = z
  .union([
    z.boolean(),
    z
      .object({
        /** Enable collector-mode subagents and agents_wait. Default: true. */
        enabled: z.boolean().optional(),
        /** Maximum concurrently running collector children per swarm group. */
        maxConcurrent: z.number().int().positive().optional(),
        /** Maximum live collector children per swarm group. */
        maxChildrenPerGroup: z.number().int().positive().optional(),
        /** Maximum lifetime collector spawns per swarm group. */
        maxTotalPerGroup: z.number().int().positive().optional(),
        /** Maximum agents_wait timeout in seconds. */
        waitTimeoutSecondsMax: z.number().int().positive().optional(),
        /** Default child agent id when sessions_spawn omits agentId. */
        defaultAgentId: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

const SandboxSshSchema = z
  .object({
    target: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    strictHostKeyChecking: z.boolean().optional(),
    updateHostKeys: z.boolean().optional(),
    identityFile: z.string().min(1).optional(),
    certificateFile: z.string().min(1).optional(),
    knownHostsFile: z.string().min(1).optional(),
    identityData: SecretInputSchema.optional().register(sensitive),
    certificateData: SecretInputSchema.optional().register(sensitive),
    knownHostsData: SecretInputSchema.optional().register(sensitive),
  })
  .strict()
  .optional();

export const AgentSandboxSchema = z
  .object({
    mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
    backend: z.string().min(1).optional(),
    workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
    sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
    scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
    workspaceRoot: z.string().optional(),
    docker: SandboxDockerSchema,
    ssh: SandboxSshSchema,
    browser: SandboxBrowserSchema,
    prune: SandboxPruneSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const blockedBrowserNetworkReason = getBlockedNetworkModeReason({
      network: data.browser?.network,
      allowContainerNamespaceJoin: data.docker?.dangerouslyAllowContainerNamespaceJoin === true,
    });
    if (blockedBrowserNetworkReason === "container_namespace_join") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["browser", "network"],
        message:
          'Sandbox security: browser network mode "container:*" is blocked by default. ' +
          "Set sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
      });
    }
  })
  .optional();

const CommonToolPolicyFields = {
  /** Base tool profile applied before allow/deny lists. */
  profile: ToolProfileSchema,
  allow: z.array(z.string()).optional(),
  /** Additional allowlist entries merged into allow and/or profile allowlist. */
  alsoAllow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  /** Optional tool policy overrides keyed by provider id or "provider/model". */
  byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
  /** Per-sender tool policy overrides keyed by sender identity. */
  toolsBySender: ToolPolicyBySenderSchema,
};

const MessageToolConfigSchema = z
  .object({
    crossContext: z
      .object({
        /** Allow sends to other channels within the same provider (default: true). */
        allowWithinProvider: z.boolean().optional(),
        /** Allow sends across different providers (default: true). */
        allowAcrossProviders: z.boolean().optional(),
        /** Cross-context marker configuration. */
        marker: z
          .object({
            /** Enable origin markers for cross-context sends (default: true). */
            enabled: z.boolean().optional(),
            /** Text prefix template, supports {channel}. */
            prefix: z.string().optional(),
            /** Text suffix template, supports {channel}. */
            suffix: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    actions: z
      .object({
        /** Message action names exposed and accepted by the message tool. */
        allow: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    broadcast: z
      .object({
        /** Enable broadcast action (default: true). */
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const GitHubToolIdentitySchema = z
  .object({
    /** Opaque generated directory version for atomic credential rotation. */
    profileId: z.string().regex(MANAGED_GITHUB_PROFILE_ID_PATTERN),
    /** OAuth generations retain a separate rotating refresh credential. */
    kind: z.literal("oauth").optional(),
    /** Optional process-local author identity for commits made by local tools. */
    gitAuthor: z
      .object({
        name: z.string().trim().min(1).optional(),
        email: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const AgentToolsSchema = z
  .object({
    ...CommonToolPolicyFields,
    /** Per-agent code mode override; merges over the top-level tools.codeMode config. */
    codeMode: CodeModeSchema,
    /** Per-agent swarm override; merges over the top-level tools.swarm config. */
    swarm: SwarmSchema,
    /** Per-agent elevated exec gate (can only further restrict global tools.elevated). */
    elevated: z
      .object({
        /** Enable or disable elevated mode for this agent (default: true). */
        enabled: z.boolean().optional(),
        /** Approved senders for /elevated (per-provider allowlists). */
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    /** Exec tool defaults for this agent. */
    exec: ToolExecSchema,
    /** Complete per-agent GitHub CLI identity and Git author override. */
    github: GitHubToolIdentitySchema,
    /** Filesystem tool path guards. */
    fs: ToolFsSchema,
    /** Runtime loop detection for repetitive/ stuck tool-call patterns. */
    loopDetection: ToolLoopDetectionSchema,
    /** Message tool configuration for this agent. */
    message: MessageToolConfigSchema,
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  })
  .optional();

export const AgentEntrySchema = AgentEntryBaseSchema.extend({
  memory: z
    .object({
      search: MemorySearchSchema,
    })
    .strict()
    .optional(),
  humanDelay: HumanDelaySchema.optional(),
  typingMode: TypingModeSchema.optional(),
  tts: AgentTtsConfigSchema,
  skillsLimits: AgentSkillsLimitsSchema,
  contextLimits: AgentContextLimitsSchema,
  heartbeat: HeartbeatSchema,
  identity: IdentitySchema,
  groupChat: GroupChatSchema.unwrap().omit({ visibleReplies: true }).optional(),
  sandbox: AgentSandboxSchema,
  tools: AgentToolsSchema,
}).strict();

export const ToolsSchema = z
  .object({
    ...CommonToolPolicyFields,
    web: ToolsWebSchema,
    /** Managed local GitHub CLI identity and Git author; never overrides Git transport. */
    github: GitHubToolIdentitySchema,
    media: ToolsMediaSchema,
    links: ToolsLinksSchema,
    /**
     * Session tool visibility controls which sessions can be targeted by session tools
     * (sessions_list, sessions_history, sessions_search, sessions_send, session_status).
     *
     * Default: "all" (all sessions on the Gateway, with cross-agent access scoped by agentToAgent).
     */
    sessions: z
      .object({
        /**
         * - "self": only the current session
         * - "tree": current session + sessions spawned by this session
         * - "agent": any session belonging to the current agent id (can include other users)
         * - "all": any session (default; cross-agent access is governed by tools.agentToAgent)
         */
        visibility: z.enum(["self", "tree", "agent", "all"]).optional(),
      })
      .strict()
      .optional(),
    loopDetection: ToolLoopDetectionSchema,
    /** Compact large OpenClaw, MCP, and client tool catalogs behind search/call tools. */
    toolSearch: ToolSearchSchema,
    /** Global Code Mode defaults and limits; agent/model settings can override activation. */
    codeMode: CodeModeSchema,
    /** Collector-mode subagents and wait controls. */
    swarm: SwarmSchema,
    /** Message tool configuration. */
    message: MessageToolConfigSchema,
    agentToAgent: z
      .object({
        /** Default: true. False blocks ordinary cross-agent session tool access; requester-owned native subagent and ACP child sessions remain reachable under tree/all visibility. */
        enabled: z.boolean().optional(),
        /**
         * Agent ids or `*` glob patterns; the requesting and target agent must both match.
         * Omitted or empty counts as unset: every agent pair is allowed by default; blank entries deny.
         */
        allow: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /** Elevated exec permissions for the host machine. */
    elevated: z
      .object({
        /** Enable or disable elevated mode (default: true). */
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    /** Exec tool defaults. */
    exec: ToolExecSchema,
    fs: ToolFsSchema,
    /** Sub-agent tool policy defaults (deny wins; progress_card is always denied). */
    subagents: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    /** Sandbox tool policy defaults (deny wins). */
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    /** sessions_spawn tool configuration. */
    sessions_spawn: z
      .object({
        attachments: z
          .object({
            /** Enable inline attachments for sessions_spawn. */
            enabled: z.boolean().optional(),
            maxTotalBytes: z.number().optional(),
            maxFiles: z.number().optional(),
            maxFileBytes: z.number().optional(),
            retainOnSessionKeep: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Unified progress_card status tool for parent sessions; enabled by default. False opts out. */
    updatePlan: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  })
  .optional();
