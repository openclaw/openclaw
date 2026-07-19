/** Public contracts for host-enforced plugin authorization policies. */
import type { PluginJsonValue } from "./host-hook-json.js";

export type AuthorizationPrincipal =
  | {
      kind: "sender";
      provider?: string;
      accountId?: string;
      senderId: string;
      /** Host-attested mutable aliases, normalized to toolsBySender selector semantics. */
      aliases?: Readonly<{
        name?: string;
        username?: string;
        e164?: string;
      }>;
      senderIsOwner?: boolean;
      isAuthorizedSender?: boolean;
      roleIds?: readonly string[];
    }
  | {
      kind: "operator";
      /** Authenticated Gateway operator scopes. Client feature capabilities never appear here. */
      scopes: readonly string[];
      clientId?: string;
      deviceId?: string;
      isOwner?: boolean;
    }
  | {
      kind: "service";
      serviceId: string;
    }
  | {
      kind: "unknown";
      provider?: string;
      accountId?: string;
    };

export type AuthorizationInvocationContext = {
  principal: AuthorizationPrincipal;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number;
  trigger?: string;
};

/** Immutable host-issued authority carried across one admitted turn. */
export type TurnAuthoritySnapshot = Readonly<{
  authorization: Readonly<AuthorizationInvocationContext>;
  /** Stable authenticated controller boundary for queue/steering isolation. */
  controllerKey?: string;
  /** Optional digest of an opaque host capability; the capability itself never crosses this seam. */
  capabilityDigest?: string;
}>;

export type AuthorizationCommandOwner =
  | { kind: "core" }
  | { kind: "plugin"; pluginId: string; pluginName?: string }
  | { kind: "skill"; skillName: string; skillSource?: string };

export type AuthorizationToolCallRequest = {
  operation: "tool.call";
  toolName: string;
  toolKind?: string;
  toolInputKind?: string;
  /** `final` is the OpenClaw-managed execution boundary; native harness relays are pre-execution. */
  phase: "final" | "pre-execution";
  /** Host-derived convenience selector from the final input's `action` field. */
  action?: string;
  input: Record<string, PluginJsonValue>;
};

export type AuthorizationMessageActionRequest = {
  operation: "message.action";
  action: string;
  channel: string;
  accountId?: string;
  target?: string;
  targets?: readonly string[];
  threadId?: string | number;
  dryRun: boolean;
  /** Canonical host-prepared action input used by the immediately following effect. */
  input: Record<string, PluginJsonValue>;
};

export type AuthorizationCommandInvokeRequest = {
  operation: "command.invoke";
  /** Session rollover is checked before mutation; final is the command execution boundary. */
  phase: "session-mutation" | "final";
  commandName: string;
  owner: AuthorizationCommandOwner;
  source: "text" | "native" | "unknown";
  arguments?: {
    raw?: string;
    values?: Record<string, PluginJsonValue>;
  };
};

export type AuthorizationOperationMap = {
  "tool.call": AuthorizationToolCallRequest;
  "message.action": AuthorizationMessageActionRequest;
  "command.invoke": AuthorizationCommandInvokeRequest;
};

export type AuthorizationOperation = keyof AuthorizationOperationMap;

export type AuthorizationPolicyDecision = { effect: "pass" } | { effect: "deny"; code: string };

export type AuthorizationPolicyHandler<K extends AuthorizationOperation> = (
  request: AuthorizationOperationMap[K],
  context: AuthorizationInvocationContext,
  signal: AbortSignal,
) => AuthorizationPolicyDecision | Promise<AuthorizationPolicyDecision>;

export type AuthorizationPolicyRegistration = {
  id: string;
  description: string;
  /** Missing handlers pass by default; `deny` makes new operation kinds fail closed. */
  unhandled?: "pass" | "deny";
  /** Per-policy evaluation budget. The host clamps this to its supported range. */
  timeoutMs?: number;
  handlers: {
    [K in AuthorizationOperation]?: AuthorizationPolicyHandler<K>;
  };
};
