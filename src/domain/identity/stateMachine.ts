export type Channel = "sms" | "email" | "voice" | "telegram";

export type Role = "pm" | "owner" | "renter" | "vendor" | "unknown";

export type AuthLevel = "none" | "verified" | "stepup_required";

export type ActionType = "read" | "write" | "notify";

export type ExecutionMode = "api-first" | "api+light-llm" | "heavy-llm";

export type IdResolution = "single_unit" | "prompt" | "infer_from_text";

export interface UnifiedMessage {
  channel: Channel;
  channelIdentity: string;
  messageText: string;
  timestampMs: number;
  threadId?: string;
  callSid?: string;
}

export interface IntentContract {
  intentSlug: string;
  executionMode: ExecutionMode;
  actionType: ActionType;
  authScope: string[];
  idResolution: IdResolution;
  isFinancial: boolean;
}

export interface SubjectCandidate {
  subjectId: string;
  role: Role;
  allowedPropertyIds: string[];
  allowedUnitIds: string[];
  allowedWorkOrderIds?: string[];
  lastVerifiedAtMs?: number;
  identityConfidence: "high" | "medium" | "low";
}

export interface RuntimeScopeContext {
  requestId: string;
  channel: Channel;
  channelIdentity: string;

  subjectId?: string;
  role: Role;

  allowedPropertyIds: string[];
  allowedUnitIds: string[];
  allowedWorkOrderIds: string[];

  activePropertyId?: string;
  activeUnitId?: string;

  authLevel: AuthLevel;
  requiresOtp: boolean;
  riskScore: number;

  decision: "allow" | "deny" | "ask_clarification" | "stepup";
  denyReason?: string;
  clarificationPrompt?: string;
}

export type State =
  | "S0_INGRESS_RECEIVED"
  | "S1_RESOLVE_IDENTITY"
  | "S1A_UNKNOWN_IDENTITY"
  | "S2_DETERMINE_ROLE_AND_SCOPE"
  | "S3_RESOLVE_ACTIVE_UNIT"
  | "S3B_NEED_SCOPE_SELECTION"
  | "S4_RISK_EVALUATION"
  | "S5_AUTHZ_GATE"
  | "DONE";

export interface MachineInput {
  msg: UnifiedMessage;
  intent: IntentContract;
  requestId: string;

  identityLookup: (channelIdentity: string) => Promise<SubjectCandidate[]>;
  sessionGetActiveUnit: (key: string) => Promise<string | undefined>;
  sessionSetActiveUnit: (key: string, unitId: string) => Promise<void>;

  onboardingAllowed: boolean;
  otpRecencyMs: number;
  nowMs: number;
}

export function normalizeChannelIdentity(channel: Channel, raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (channel === "email") {
    return trimmed;
  }
  return trimmed.replace(/[^\d+]/g, "");
}

export function inferUnitIdFromText(messageText: string): string | undefined {
  const match = messageText.toLowerCase().match(/\b(unit|apt|apartment)\s*#?\s*(\d{1,6})\b/);
  return match?.[2];
}

export function sessionKeyFor(msg: UnifiedMessage): string {
  if (msg.channel === "email" && msg.threadId) {
    return `email:${msg.threadId}`;
  }
  if (msg.channel === "voice" && msg.callSid) {
    return `voice:${msg.callSid}`;
  }
  return `${msg.channel}:${msg.channelIdentity}`;
}

export function pickBestRole(candidates: SubjectCandidate[]): SubjectCandidate {
  const rank: Record<Role, number> = {
    pm: 0,
    owner: 1,
    renter: 2,
    vendor: 3,
    unknown: 9,
  };
  return [...candidates].toSorted((left, right) => rank[left.role] - rank[right.role])[0];
}

export async function runIdentityScopeMachine(input: MachineInput): Promise<RuntimeScopeContext> {
  const msg: UnifiedMessage = {
    ...input.msg,
    channelIdentity: normalizeChannelIdentity(input.msg.channel, input.msg.channelIdentity),
  };

  let state: State = "S0_INGRESS_RECEIVED";
  let ctx: RuntimeScopeContext = {
    requestId: input.requestId,
    channel: msg.channel,
    channelIdentity: msg.channelIdentity,
    role: "unknown",
    allowedPropertyIds: [],
    allowedUnitIds: [],
    allowedWorkOrderIds: [],
    authLevel: "none",
    requiresOtp: false,
    riskScore: 0,
    decision: "deny",
  };

  for (let guard = 0; guard < 20; guard += 1) {
    if (state === "DONE") {
      return ctx;
    }

    switch (state) {
      case "S0_INGRESS_RECEIVED": {
        state = "S1_RESOLVE_IDENTITY";
        break;
      }

      case "S1_RESOLVE_IDENTITY": {
        const candidates = await input.identityLookup(msg.channelIdentity);
        if (!candidates || candidates.length === 0) {
          state = "S1A_UNKNOWN_IDENTITY";
          break;
        }
        const chosen = pickBestRole(candidates);

        ctx.subjectId = chosen.subjectId;
        ctx.role = chosen.role;
        ctx.allowedPropertyIds = chosen.allowedPropertyIds;
        ctx.allowedUnitIds = chosen.allowedUnitIds;
        ctx.allowedWorkOrderIds = chosen.allowedWorkOrderIds ?? [];
        ctx.authLevel = chosen.lastVerifiedAtMs ? "verified" : "none";

        state = "S2_DETERMINE_ROLE_AND_SCOPE";
        break;
      }

      case "S1A_UNKNOWN_IDENTITY": {
        if (!input.onboardingAllowed) {
          ctx.decision = "deny";
          ctx.denyReason = "unknown_identity_on_channel";
          state = "DONE";
          break;
        }

        ctx.decision = "stepup";
        ctx.requiresOtp = true;
        ctx.authLevel = "stepup_required";
        state = "DONE";
        break;
      }

      case "S2_DETERMINE_ROLE_AND_SCOPE": {
        if (!ctx.subjectId) {
          ctx.decision = "deny";
          ctx.denyReason = "identity_resolution_failed";
          state = "DONE";
          break;
        }
        state = "S3_RESOLVE_ACTIVE_UNIT";
        break;
      }

      case "S3_RESOLVE_ACTIVE_UNIT": {
        const units = ctx.allowedUnitIds ?? [];
        if (units.length === 0) {
          ctx.decision = "deny";
          ctx.denyReason = "no_scope_units";
          state = "DONE";
          break;
        }

        if (units.length === 1) {
          ctx.activeUnitId = units[0];
          state = "S4_RISK_EVALUATION";
          break;
        }

        const key = sessionKeyFor(msg);
        const cached = await input.sessionGetActiveUnit(key);
        if (cached && units.includes(cached)) {
          ctx.activeUnitId = cached;
          state = "S4_RISK_EVALUATION";
          break;
        }

        const inferredUnit = inferUnitIdFromText(msg.messageText);
        if (inferredUnit && units.includes(inferredUnit)) {
          ctx.activeUnitId = inferredUnit;
          await input.sessionSetActiveUnit(key, inferredUnit);
          state = "S4_RISK_EVALUATION";
          break;
        }

        state = "S3B_NEED_SCOPE_SELECTION";
        break;
      }

      case "S3B_NEED_SCOPE_SELECTION": {
        ctx.decision = "ask_clarification";
        ctx.clarificationPrompt =
          msg.channel === "sms"
            ? "Which unit is this for? Reply with the unit number (e.g., “402”)."
            : "Please confirm the unit number (e.g., Unit 402) so I can access the correct account.";
        state = "DONE";
        break;
      }

      case "S4_RISK_EVALUATION": {
        const isSensitive = input.intent.isFinancial || input.intent.intentSlug.includes("payoff");

        const lastVerified = await getLastVerifiedAt(input, ctx);
        const stale =
          isSensitive && (!lastVerified || input.nowMs - lastVerified > input.otpRecencyMs);

        const multiUnit = (ctx.allowedUnitIds?.length ?? 0) > 1;
        const risk = (isSensitive ? 50 : 10) + (multiUnit ? 10 : 0) + (stale ? 30 : 0);

        ctx.riskScore = Math.min(100, risk);
        ctx.requiresOtp = stale;
        ctx.authLevel = stale ? "stepup_required" : ctx.authLevel;

        state = "S5_AUTHZ_GATE";
        break;
      }

      case "S5_AUTHZ_GATE": {
        if (!isIntentAllowedOnChannel(msg.channel, input.intent.intentSlug)) {
          ctx.decision = "deny";
          ctx.denyReason = "channel_scope_denied";
          state = "DONE";
          break;
        }

        if (!ctx.activeUnitId || !(ctx.allowedUnitIds ?? []).includes(ctx.activeUnitId)) {
          ctx.decision = "deny";
          ctx.denyReason = "unit_scope_denied";
          state = "DONE";
          break;
        }

        if (!hasPermission(ctx.role, input.intent.authScope)) {
          ctx.decision = "deny";
          ctx.denyReason = "action_permission_denied";
          state = "DONE";
          break;
        }

        if (ctx.requiresOtp) {
          ctx.decision = "stepup";
          state = "DONE";
          break;
        }

        ctx.decision = "allow";
        state = "DONE";
        break;
      }

      default: {
        ctx.decision = "deny";
        ctx.denyReason = "unknown_state";
        state = "DONE";
      }
    }
  }

  ctx.decision = "deny";
  ctx.denyReason = "state_machine_guard_exceeded";
  return ctx;
}

async function getLastVerifiedAt(
  input: MachineInput,
  ctx: RuntimeScopeContext,
): Promise<number | undefined> {
  return ctx.authLevel === "verified" ? input.nowMs - 5 * 24 * 60 * 60 * 1000 : undefined;
}

export function isIntentAllowedOnChannel(channel: Channel, intentSlug: string): boolean {
  return intentSlug.length > 0 && ["sms", "email", "voice", "telegram"].includes(channel);
}

export function hasPermission(role: Role, scopes: string[]): boolean {
  const perms: Record<Role, string[]> = {
    pm: [
      "ledger:read",
      "ledger:write",
      "workorder:read",
      "workorder:write",
      "rules:read",
      "contact:write",
    ],
    owner: ["ledger:read", "workorder:read", "workorder:write", "rules:read"],
    renter: ["workorder:read", "workorder:write", "rules:read"],
    vendor: ["workorder:read", "workorder:write"],
    unknown: [],
  };

  const allowed = new Set(perms[role] ?? []);
  return scopes.every((scope) => allowed.has(scope));
}
