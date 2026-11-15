// Plugin runtime types describe activated plugin capabilities exposed to core execution.
// Owner schema module import keeps the ProtocolSchemas registry out of the
// public plugin-sdk dts graph (check-plugin-sdk-exports guards this).
import type { NodePluginToolDescriptor } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { LlmCompleteUsage } from "./runtime-llm.types.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";
import type { NativeSubagentRuntime } from "./types-native-subagent.js";
import type {
  RuntimeSessionFactsResult,
  RuntimeSessionFactsSelection,
  RuntimeSessionFactsSelectionResult,
} from "./types-session-facts.js";

export type { RuntimeLogger };

type PluginRuntimeChannel = import("./types-channel.js").PluginRuntimeChannel;

type SubagentRunParams = {
  /** Revalidate command authority at the host's run admission boundary. */
  assertCurrent?: () => void;
  sessionKey: string;
  message: string;
  /** Run with an exact empty tool surface. */
  disableTools?: boolean;
  /** Add exact tools registered by the calling plugin to the worker's normal tool surface. */
  toolsAlsoAllow?: string[];
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  /** Use the bounded subagent prompt instead of the full conversation prompt. */
  promptMode?: "minimal";
  lane?: string;
  lightContext?: boolean;
  deliver?: boolean;
  /** Deliver the completion to the authenticated requester of the current hook invocation. */
  completionDelivery?: "current-requester";
  idempotencyKey?: string;
  cwd?: string;
};

type SubagentCompleteParams = {
  agentId: string;
  message: string;
  extraSystemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** The stored session generation a forked turn read, for follow-up writes to that same generation. */
export type SubagentForkedTurnSource = {
  sessionId: string;
  lifecycleRevision: string | null;
};

/**
 * `cancelled` marks an expected stop (the caller's signal, a Gateway restart drain, yielding to
 * foreground work, or the source session changing); any other failure is a real error.
 */
type SubagentForkedTurnOutcome = {
  runId: string;
  /** Absent when the fork stopped before it admitted the source session. */
  source?: SubagentForkedTurnSource;
} & ({ ok: true; text?: string } | { ok: false; error: unknown; cancelled: boolean });

export type SubagentForkedTurnParams<T> = {
  sessionKey: string;
  /**
   * The completed transcript entry the fork reads through. Refused when the session was
   * replaced (`sessionId` no longer current) or the entry is no longer on its active transcript.
   * A reset that keeps the session id is reported through `outcome.source.lifecycleRevision`.
   */
  through: { sessionId: string; entryId: string };
  prompt: string;
  /**
   * Tools the calling plugin registered. Core tools and tools another plugin registered are
   * refused; the session's tool policy must also allow each one, or the run is not admitted.
   */
  tools: readonly string[];
  /** Full provider/model override; requires the same trust as `subagent.run` overrides. */
  provider?: string;
  model?: string;
  /** Caller-chosen id so tools' records can be found even when the run fails; unique per run. */
  runId?: string;
  /** Defaults to 120 seconds; a larger value runs longer (the agent timeout, for example). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Runs after the fork stops, inside the same Gateway work admission, so a graceful restart
   * waits for it. Its return value is the call's `value`.
   */
  onSettled: (outcome: SubagentForkedTurnOutcome) => Promise<T> | T;
};

export type SubagentForkedTurnResult<T> =
  | { status: "settled"; runId: string; value: T }
  /** The session's tool policy does not allow every requested tool; nothing ran. */
  | { status: "refused"; reason: "tool_policy" };

type PluginManagedWorktree = {
  id: string;
  path: string;
  branch: string;
};

type SubagentRunResult = {
  runId: string;
  /** Canonical accepted session identity. Optional for explicit/custom runtimes. */
  sessionKey?: string;
  runtime?: {
    harness: string;
    provider: string;
    model: string;
  };
};

type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

type RuntimeNodeListParams = {
  connected?: boolean;
};

type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    platform?: string;
    clientId?: string;
    remoteIp?: string;
    connected?: boolean;
    connectedAtMs?: number;
    lastSeenAtMs?: number;
    caps?: string[];
    commands?: string[];
    /** True only for the node host installed alongside this Gateway. */
    gatewayLocal?: boolean;
    /** Advertised commands currently permitted by Gateway node-command policy. */
    invocableCommands?: string[];
    nodePluginTools?: NodePluginToolDescriptor[];
  }>;
};

type RuntimeNodeInvokeParams = {
  nodeId: string;
  command: string;
  params?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  sessionKey?: string;
  /** Cancel the invocation and any work already dispatched to a first-party node. */
  signal?: AbortSignal;
  /** Caller-owned authority remains current through dispatch and duplex delivery. */
  assertCurrent?: () => void;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
};

/** A lifecycle-bound, complete-message binary channel for one node invocation. */
type RuntimeNodeDuplexChannel = {
  send: (message: Uint8Array) => Promise<void>;
  onMessage: (listener: (message: Uint8Array) => void | Promise<void>) => () => void;
  closed: Promise<unknown>;
  close: () => void;
};

export type RuntimeGatewayRequestOptions = {
  timeoutMs?: number;
  /** Cancel this request without extending the current caller or plugin lifetime. */
  signal?: AbortSignal;
  /** Requested Gateway scopes. Honored only for bundled or trusted official plugins. */
  scopes?: OperatorScope[];
  /** Fence an in-process channel send to the exact current requester session incarnation. */
  sessionDeliveryGeneration?: {
    sessionKey: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
};

/** One plugin-written agent message; see `api.runtime.gateway.appendAgentMessage`. */
export type RuntimeAgentMessage = {
  sessionKey: string;
  agentId?: string;
  /** Displayed Markdown, normalized like typed chat input; mention spans are UTF-16 offsets into it. */
  text: string;
  /** Spans selecting `@label` text for people to notify; the caller cannot mention themselves. */
  mentions?: ReadonlyArray<{ profileId: string; start: number; end: number }>;
  /** Stable per message; a retry replays the same transcript row and Inbox entry. */
  idempotencyKey: string;
};

export type RuntimeAgentMessageResult = { messageId: string; replayed: boolean };

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  gateway: {
    /** Whether this process owns an active Gateway request context. */
    isAvailable: () => Promise<boolean>;
    /** Dispatch a Gateway method as the current trusted plugin. */
    request: <T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      options?: RuntimeGatewayRequestOptions,
    ) => Promise<T>;
    /** Open this plugin's native panel in the requesting Control UI, preserving caller authority. */
    openPluginPanel: (params: {
      panelId: string;
      sessionKey: string;
      agentId?: string;
    }) => Promise<{ ok: true }>;
    /** Bounded redacted facts for up to 40 sessions; excludes incognito and rechecks the bound caller/lifecycle. */
    readSessionFacts: (params: {
      sessionKeys: readonly string[];
    }) => Promise<RuntimeSessionFactsResult>;
    /** Select immutable current session facts, retaining caller authority through the consumer. */
    withSessionFacts: <T>(
      select: RuntimeSessionFactsSelection,
      run: (snapshot: RuntimeSessionFactsSelectionResult) => Promise<T>,
    ) => Promise<T>;
    /**
     * Inside an authenticated RPC handler, add one agent-authored message to a session the
     * caller may write, without a model run. The caller is named as the Inbox sender.
     */
    appendAgentMessage: (params: RuntimeAgentMessage) => Promise<RuntimeAgentMessageResult>;
    /** Keyed fact invalidations; callers own unsubscribe. Broad store changes are excluded. */
    subscribeSessionChanges: (
      listener: (event: { agentId: string; sessionKey: string; factsInvalidated?: string }) => void,
    ) => () => void;
    withUserProfileIdentity?: <T>(
      params: {
        profileId: string;
        emails: readonly string[];
        githubAccountIds?: readonly number[];
      },
      run: (assertCurrent: () => void) => Promise<T>,
    ) => Promise<T>;
    /** Resolve public GitHub identity with the Gateway credential; never retry anonymously. */
    resolveGitHubAccount?: (params: { login: string; signal?: AbortSignal }) => Promise<
      | { accountId: number; login: string; error?: never }
      | {
          error: {
            statusCode: number;
            message: string;
            retryAtMs?: number;
            credentialConfigured: boolean;
          };
        }
    >;
  };
  subagent: {
    /** Native collector children; only callable during requester-bound reply_dispatch. */
    native?: NativeSubagentRuntime;
    /** Fresh, tool-free background inference under the existing subagent model policy. */
    complete: (params: SubagentCompleteParams) => Promise<{ text: string }>;
    /** Ephemeral session-context inference on the session's model, with tool execution denied. */
    forkSession: (params: {
      sessionKey: string;
      message: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    }) => Promise<{ text: string; usage?: LlmCompleteUsage }>;
    /**
     * Hidden background turn over a bounded copy of a stored session, through one completed
     * entry, with only the caller's own tools. Never writes the source transcript.
     */
    runForkedTurn: <T>(params: SubagentForkedTurnParams<T>) => Promise<SubagentForkedTurnResult<T>>;
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<AgentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
    /** Open a connection-scoped binary node command inside the trusted Gateway runtime. */
    openDuplex: (
      params: RuntimeNodeInvokeParams & {
        maxMessageBytes?: number;
        maxOutstandingDeliveryBytes?: number;
      },
    ) => Promise<RuntimeNodeDuplexChannel>;
  };
  sandbox: {
    resolveWorkspaceAuthority: (params: {
      config: OpenClawConfig;
      agentId?: string;
      storePath?: string;
      confinedToolNames?: readonly string[];
      requiredToolNames?: readonly string[];
      modelProvider?: string;
      modelId?: string;
      sessionKey: string;
    }) => {
      sandboxed: boolean;
      workspaceAccess: "none" | "ro" | "rw";
      confinementError?: string;
    };
    prepareWorkspaceAuthority: (
      params: Parameters<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>[0] & {
        workspaceDir: string;
      },
    ) => Promise<ReturnType<PluginRuntime["sandbox"]["resolveWorkspaceAuthority"]>>;
  };
  worktrees: {
    resolveCheckoutRoot: (params: { path: string }) => Promise<string | undefined>;
    hasSelfContainedCheckoutMetadata?: (params: { path: string }) => Promise<boolean>;
    create: (params: {
      repoRoot: string;
      name: string;
      baseRef?: string;
      ownerKind: "workboard";
      ownerId: string;
      commitGuard?: () => void;
    }) => Promise<PluginManagedWorktree>;
    release: (params: { path: string }) => Promise<void>;
    removeIfLossless: (params: {
      path: string;
      ownerKind: "workboard";
      ownerId: string;
    }) => Promise<boolean>;
  };
  /** Core-owned per-skill usage, keyed by SKILL.md path; written for every demonstrated skill use. */
  skills: {
    /**
     * Usage for the given SKILL.md paths, keyed by the paths as given. Files without recorded
     * use are absent. When `tracked` is false this process does not persist skill use, so an
     * absent entry is not evidence that the skill went unused.
     */
    readUsage: (params: { skillFiles: readonly string[] }) => Promise<{
      tracked: boolean;
      usage: ReadonlyMap<string, { useCount: number; lastUsedAtMs: number }>;
    }>;
    /**
     * Records one read of an absolute SKILL.md path by the executing tool call. Run, session,
     * and agent attribution come from that call. Returns false outside a live tool execution.
     */
    recordUsed: (params: {
      skillFile: string;
      skillName: string;
      skillSource?: "bundled" | "workspace";
    }) => boolean;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  dispatchReplyFromConfig?: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
  gateway?: PluginRuntime["gateway"];
  hooks?: PluginRuntime["hooks"];
  subagent?: PluginRuntime["subagent"];
  nodes?: PluginRuntime["nodes"];
  /** Native policy facades avoid re-evaluating SDK dependencies during registration. */
  modelAuth?: PluginRuntime["modelAuth"];
  modelConfig?: PluginRuntime["modelConfig"];
  allowGatewaySubagentBinding?: boolean;
};

/** Host-owned facades retained by the path-loaded runtime. */
export type PluginRuntimeBase = Pick<
  PluginRuntime,
  "capabilities" | "config" | "llm" | "state" | "system"
>;

/** Checked contract for both the path-loaded factory and its implementation. */
export type PluginRuntimeFactory = (
  options?: CreatePluginRuntimeOptions,
  base?: PluginRuntimeBase,
) => PluginRuntime;
