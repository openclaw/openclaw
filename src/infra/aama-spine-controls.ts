import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { installProcessWarningFilter } from "./warning-filter.js";

export type AamaPolicyDecision = {
  decision: "allow" | "approval_required" | "block";
  reasons: string[];
};

export type AamaMemoryDecision = {
  decision: "allow" | "approval_required" | "block";
  reasons: string[];
  quarantineRequired: boolean;
  quarantineReasons: string[];
  actionBlocked: boolean;
  escalationRequired: boolean;
};

type LoadedAamaPhase1Config = {
  root: string;
  approvalRules: {
    authority_model?: {
      tiffany?: { approves?: string[] };
      christian?: { approves?: string[] };
      self_authorized_by_tier?: string[];
    };
    constraints?: {
      approval_token_required_for_external_send?: boolean;
      send_external_allowlist_bypass?: boolean;
      ambiguous_default_approver_allowed?: boolean;
    };
  };
  writeControls: {
    memory_write_modes?: Record<
      string,
      {
        allowed?: boolean;
        approval_required?: boolean;
        requires_source_refs?: boolean;
      }
    >;
  };
  suspensionRules: {
    auto_suspend?: {
      approval_token_bypass?: number;
      unauthorized_external_action?: number;
      high_severity_policy_violations_7d?: number;
      contradiction_backlog_hard_limit_days?: number;
      noise_budget_breach_consecutive_weeks?: number;
    };
  };
  memorySchema: {
    required?: string[];
    properties?: Record<
      string,
      {
        enum?: unknown[];
        type?: string | string[];
        minimum?: number;
        maximum?: number;
      }
    >;
    additionalProperties?: boolean;
  };
};

type ApprovalTokenClaims = {
  jti: string;
  actor: string;
  action_type: string;
  payload_hash: string;
  nonce: string;
  iat: number;
  exp: number;
  approver: string;
};

export type EnforceMessageActionParams = {
  action: string;
  channel: string;
  actor: string;
  requesterSenderId?: string | null;
  actionParams: Record<string, unknown>;
  payload: Record<string, unknown>;
};

export type EnforceMemoryWriteParams = {
  actor: string;
  writeMode: string;
  record: Record<string, unknown>;
  contradictionAgeDays?: number;
  contradictionUnresolved?: boolean;
};

const REQUIRED_PHASE1_FILES = [
  "core/approval_rules.yaml",
  "policy/suspension_rules.yaml",
  "policy/write_controls.yaml",
  "memory/schema/memory_schema_v1.json",
] as const;

const require = createRequire(import.meta.url);
const AAMA_POLICY_STATE_DB_BASENAME = "policy-gate-state.sqlite";
const AUTONOMY_SUSPENDED_FLAG_KEY = "autonomy_suspended";

type SqliteModule = typeof import("node:sqlite");
type SqliteDatabase = import("node:sqlite").DatabaseSync;

let configCache: { root: string; value: LoadedAamaPhase1Config } | null = null;
let sqliteModuleCache: SqliteModule | null = null;

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isAamaPhase1EnforcementEnabled(): boolean {
  return isTruthy(process.env.OPENCLAW_AAMA_PHASE1_ENABLE);
}

function resolvePhase1Root(): string {
  const fromEnv = process.env.OPENCLAW_AAMA_PHASE1_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), "..", "aama", "phase1_spine_package");
}

function resolveAamaPolicyStateDbPath(root: string): string {
  return path.join(root, "governance", "spine", "state", AAMA_POLICY_STATE_DB_BASENAME);
}

function requireNodeSqliteForAama(): SqliteModule {
  if (sqliteModuleCache) {
    return sqliteModuleCache;
  }
  installProcessWarningFilter();
  try {
    sqliteModuleCache = require("node:sqlite") as SqliteModule;
    return sqliteModuleCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AAMA policy_gate persistent state requires node:sqlite support. ${message}`, {
      cause: err,
    });
  }
}

function initializeAamaPolicyStateSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumed_approval_tokens (
      token_id TEXT PRIMARY KEY,
      consumed_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function formatPersistentStateError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function withAamaPolicyStateDb<T>(operation: (db: SqliteDatabase) => T): Promise<T> {
  const config = await loadAamaPhase1Config();
  const dbPath = resolveAamaPolicyStateDbPath(config.root);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const { DatabaseSync } = requireNodeSqliteForAama();
  const db = new DatabaseSync(dbPath);
  try {
    initializeAamaPolicyStateSchema(db);
    return operation(db);
  } catch (error) {
    const reason = formatPersistentStateError(error);
    throw new Error(`AAMA policy_gate persistent state failure: ${reason}`, { cause: error });
  } finally {
    db.close();
  }
}

async function isAutonomySuspendedInPersistentState(): Promise<boolean> {
  return await withAamaPolicyStateDb((db) => {
    const row = db
      .prepare("SELECT value FROM policy_flags WHERE key = ?")
      .get(AUTONOMY_SUSPENDED_FLAG_KEY) as { value?: string } | undefined;
    return row?.value === "1";
  });
}

async function persistAutonomySuspendedState(): Promise<void> {
  await withAamaPolicyStateDb((db) => {
    db.prepare(
      `
        INSERT INTO policy_flags (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    ).run(AUTONOMY_SUSPENDED_FLAG_KEY, "1", new Date().toISOString());
  });
}

async function consumeApprovalTokenId(tokenId: string): Promise<boolean> {
  return await withAamaPolicyStateDb((db) => {
    const result = db
      .prepare(
        `
          INSERT INTO consumed_approval_tokens (token_id, consumed_at)
          VALUES (?, ?)
          ON CONFLICT(token_id) DO NOTHING
        `,
      )
      .run(tokenId, new Date().toISOString()) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  });
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).toSorted();
    for (const key of keys) {
      const child = record[key];
      if (child !== undefined) {
        output[key] = stableNormalize(child);
      }
    }
    return output;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function computeSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readTrimmedString(
  params: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function requiredClaimNumber(claims: Record<string, unknown>, key: string): number {
  const value = claims[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`approval token missing numeric claim: ${key}`);
}

function requiredClaimString(claims: Record<string, unknown>, key: string): string {
  const value = claims[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`approval token missing string claim: ${key}`);
}

function decodeBase64Url(text: string): Buffer {
  const pad = text.length % 4;
  const padded = pad === 0 ? text : `${text}${"=".repeat(4 - pad)}`;
  return Buffer.from(padded.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function decodeApprovalToken(token: string): {
  claims: ApprovalTokenClaims;
  payloadSegment: string;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid approval token format");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const secret = process.env.OPENCLAW_AAMA_APPROVAL_SECRET?.trim();
  if (!secret) {
    throw new Error("OPENCLAW_AAMA_APPROVAL_SECRET is required when AAMA enforcement is enabled");
  }

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const providedSig = decodeBase64Url(signatureSegment);
  if (
    expectedSig.length !== providedSig.length ||
    !crypto.timingSafeEqual(expectedSig, providedSig)
  ) {
    throw new Error("approval token signature mismatch");
  }

  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(decodeBase64Url(payloadSegment).toString("utf-8"));
  } catch {
    throw new Error("approval token payload is not valid JSON");
  }
  if (!rawClaims || typeof rawClaims !== "object") {
    throw new Error("approval token payload must be an object");
  }

  const claimsObj = rawClaims as Record<string, unknown>;
  const claims: ApprovalTokenClaims = {
    jti: requiredClaimString(claimsObj, "jti"),
    actor: requiredClaimString(claimsObj, "actor"),
    action_type: requiredClaimString(claimsObj, "action_type"),
    payload_hash: requiredClaimString(claimsObj, "payload_hash"),
    nonce: requiredClaimString(claimsObj, "nonce"),
    iat: requiredClaimNumber(claimsObj, "iat"),
    exp: requiredClaimNumber(claimsObj, "exp"),
    approver: requiredClaimString(claimsObj, "approver"),
  };

  return { claims, payloadSegment };
}

function isTypeCompatible(value: unknown, schemaType: string | string[]): boolean {
  const allowed = Array.isArray(schemaType) ? schemaType : [schemaType];
  for (const entry of allowed) {
    if (entry === "string" && typeof value === "string") {
      return true;
    }
    if (entry === "number" && typeof value === "number" && Number.isFinite(value)) {
      return true;
    }
    if (entry === "integer" && typeof value === "number" && Number.isInteger(value)) {
      return true;
    }
    if (entry === "boolean" && typeof value === "boolean") {
      return true;
    }
    if (
      entry === "object" &&
      Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return true;
    }
    if (entry === "array" && Array.isArray(value)) {
      return true;
    }
    if (entry === "null" && value === null) {
      return true;
    }
  }
  return false;
}

async function readLastEventHash(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return null;
    }
    const parsed = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    const hash = parsed.event_hash;
    return typeof hash === "string" && hash.trim() ? hash : null;
  } catch {
    return null;
  }
}

function createEventHash(event: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(event).toSorted()) {
    if (key !== "event_hash") {
      normalized[key] = stableNormalize(event[key]);
    }
  }
  return computeSha256(JSON.stringify(normalized));
}

function buildActionType(action: string): string {
  if (action === "send" || action === "broadcast") {
    return "send_external_message";
  }
  if (action === "poll") {
    return "external_followup_send";
  }
  return "external_followup_send";
}

function resolveApproverActions(config: LoadedAamaPhase1Config): Set<string> {
  const authority = config.approvalRules.authority_model;
  const mapped = [
    ...(authority?.tiffany?.approves ?? []),
    ...(authority?.christian?.approves ?? []),
  ];
  return new Set(mapped);
}

async function appendGovernanceEvent(params: {
  lane: "append_only_audit_log" | "attestation_events";
  eventType: string;
  actor: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const config = await loadAamaPhase1Config();
  const lanePath = path.join(config.root, "governance", "spine", params.lane, "events.jsonl");
  await fs.mkdir(path.dirname(lanePath), { recursive: true });
  const prevHash = await readLastEventHash(lanePath);
  const event: Record<string, unknown> = {
    event_id: `${params.eventType}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    type: params.eventType,
    actor: params.actor,
    timestamp: new Date().toISOString(),
    details: params.details,
    prev_hash: prevHash,
  };
  event.event_hash = createEventHash(event);
  await fs.appendFile(lanePath, `${JSON.stringify(event)}\n`, "utf-8");
}

async function loadAamaPhase1Config(): Promise<LoadedAamaPhase1Config> {
  const root = resolvePhase1Root();
  if (configCache && configCache.root === root) {
    return configCache.value;
  }

  for (const rel of REQUIRED_PHASE1_FILES) {
    const target = path.join(root, rel);
    try {
      await fs.access(target);
    } catch {
      throw new Error(`AAMA Phase 1 required file missing: ${target}`);
    }
  }

  const approvalRulesRaw = await fs.readFile(
    path.join(root, "core", "approval_rules.yaml"),
    "utf-8",
  );
  const writeControlsRaw = await fs.readFile(
    path.join(root, "policy", "write_controls.yaml"),
    "utf-8",
  );
  const suspensionRulesRaw = await fs.readFile(
    path.join(root, "policy", "suspension_rules.yaml"),
    "utf-8",
  );
  const schemaRaw = await fs.readFile(
    path.join(root, "memory", "schema", "memory_schema_v1.json"),
    "utf-8",
  );

  const value: LoadedAamaPhase1Config = {
    root,
    approvalRules: (parseYaml(approvalRulesRaw) ?? {}) as LoadedAamaPhase1Config["approvalRules"],
    writeControls: (parseYaml(writeControlsRaw) ?? {}) as LoadedAamaPhase1Config["writeControls"],
    suspensionRules: (parseYaml(suspensionRulesRaw) ??
      {}) as LoadedAamaPhase1Config["suspensionRules"],
    memorySchema: (JSON.parse(schemaRaw) ?? {}) as LoadedAamaPhase1Config["memorySchema"],
  };

  configCache = { root, value };
  return value;
}

async function assertAutonomyNotSuspended(): Promise<void> {
  const suspended = await isAutonomySuspendedInPersistentState();
  if (suspended) {
    throw new Error(
      "AAMA policy_gate blocked action: autonomy is suspended after prior approval-token bypass",
    );
  }
}

async function suspendAutonomy(params: {
  actor: string;
  reason: string;
  action: string;
  channel: string;
  requesterSenderId?: string | null;
}): Promise<void> {
  await persistAutonomySuspendedState();
  await appendGovernanceEvent({
    lane: "append_only_audit_log",
    eventType: "approval_token_bypass_detected",
    actor: params.actor,
    details: {
      reason: params.reason,
      action: params.action,
      channel: params.channel,
      requester_sender_id: params.requesterSenderId ?? null,
    },
  });
  await appendGovernanceEvent({
    lane: "append_only_audit_log",
    eventType: "autonomy_suspended",
    actor: "autonomy_safety_controller",
    details: {
      trigger: "approval_token_bypass",
      reason: params.reason,
      action: params.action,
      channel: params.channel,
    },
  });
}

async function validateApprovalTokenBinding(params: {
  token: string;
  expectedActor: string;
  expectedActionType: string;
  expectedPayloadHash: string;
  expectedNonce: string;
}): Promise<ApprovalTokenClaims> {
  const decoded = decodeApprovalToken(params.token);
  const claims = decoded.claims;
  const now = Math.floor(Date.now() / 1000);

  if (claims.exp < now) {
    throw new Error("approval token expired");
  }
  if (claims.actor !== params.expectedActor) {
    throw new Error("approval token actor mismatch");
  }
  if (claims.action_type !== params.expectedActionType) {
    throw new Error("approval token action_type mismatch");
  }
  if (claims.payload_hash !== params.expectedPayloadHash) {
    throw new Error("approval token payload_hash mismatch");
  }
  if (claims.nonce !== params.expectedNonce) {
    throw new Error("approval token nonce mismatch");
  }
  const consumed = await consumeApprovalTokenId(claims.jti);
  if (!consumed) {
    throw new Error("approval token already consumed");
  }
  return claims;
}

function evaluateSchema(params: {
  schema: LoadedAamaPhase1Config["memorySchema"];
  record: Record<string, unknown>;
}): string[] {
  const errors: string[] = [];
  const required = new Set(params.schema.required ?? []);
  const props = params.schema.properties ?? {};

  const missing = [...required].filter((field) => !(field in params.record)).toSorted();
  if (missing.length > 0) {
    errors.push(`missing required fields: ${missing.join(", ")}`);
  }

  if (params.schema.additionalProperties === false) {
    const extras = Object.keys(params.record)
      .filter((key) => !(key in props))
      .toSorted();
    if (extras.length > 0) {
      errors.push(`unexpected schema fields: ${extras.join(", ")}`);
    }
  }

  for (const [field, spec] of Object.entries(props)) {
    if (!(field in params.record)) {
      continue;
    }
    const value = params.record[field];

    if (spec.enum && spec.enum.length > 0 && !spec.enum.includes(value)) {
      errors.push(`${field} must be one of ${JSON.stringify(spec.enum)}`);
    }
    if (spec.type && !isTypeCompatible(value, spec.type)) {
      errors.push(`${field} has invalid type`);
    }
    if (typeof spec.minimum === "number" && typeof value === "number" && value < spec.minimum) {
      errors.push(`${field} must be >= ${spec.minimum}`);
    }
    if (typeof spec.maximum === "number" && typeof value === "number" && value > spec.maximum) {
      errors.push(`${field} must be <= ${spec.maximum}`);
    }
  }

  return errors;
}

export async function enforceAamaPolicyGateForMessageAction(
  params: EnforceMessageActionParams,
): Promise<AamaPolicyDecision> {
  if (!isAamaPhase1EnforcementEnabled()) {
    return { decision: "allow", reasons: ["AAMA Phase 1 enforcement disabled"] };
  }

  const actor = params.actor.trim() || "system";
  const config = await loadAamaPhase1Config();
  await assertAutonomyNotSuspended();

  const constraints = config.approvalRules.constraints ?? {};
  const actionType = buildActionType(params.action);
  const knownApproverActions = resolveApproverActions(config);

  const bypass = readTrimmedString(params.actionParams, [
    "allowlistBypass",
    "allowlist_bypass",
    "approvalBypass",
    "approval_bypass",
  ]);
  if (constraints.send_external_allowlist_bypass === false && bypass === "true") {
    const reason = "external send allowlist bypass attempt blocked";
    await suspendAutonomy({
      actor,
      reason,
      action: params.action,
      channel: params.channel,
      requesterSenderId: params.requesterSenderId,
    });
    throw new Error(`AAMA policy_gate blocked action: ${reason}`);
  }

  if (!knownApproverActions.has(actionType)) {
    const reason = `external action is not mapped in approval_rules.yaml: ${actionType}`;
    await appendGovernanceEvent({
      lane: "append_only_audit_log",
      eventType: "policy_gate_blocked",
      actor,
      details: {
        reason,
        action: params.action,
        mapped_action_type: actionType,
        channel: params.channel,
      },
    });
    throw new Error(`AAMA policy_gate blocked action: ${reason}`);
  }

  const tokenRequired = constraints.approval_token_required_for_external_send === true;
  if (tokenRequired) {
    const approvalToken = readTrimmedString(params.actionParams, [
      "approvalToken",
      "approval_token",
    ]);
    const approvalNonce = readTrimmedString(params.actionParams, [
      "approvalNonce",
      "approval_nonce",
    ]);

    if (!approvalToken || !approvalNonce) {
      const reason = "approval token is required for external send";
      await suspendAutonomy({
        actor,
        reason,
        action: params.action,
        channel: params.channel,
        requesterSenderId: params.requesterSenderId,
      });
      throw new Error(`AAMA policy_gate blocked action: ${reason}`);
    }

    const payloadHash = computeSha256(stableStringify(params.payload));
    try {
      const claims = await validateApprovalTokenBinding({
        token: approvalToken,
        expectedActor: actor,
        expectedActionType: actionType,
        expectedPayloadHash: payloadHash,
        expectedNonce: approvalNonce,
      });
      await appendGovernanceEvent({
        lane: "append_only_audit_log",
        eventType: "approval_token_consumed",
        actor,
        details: {
          action: params.action,
          mapped_action_type: actionType,
          channel: params.channel,
          approver: claims.approver,
          token_id: claims.jti,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await suspendAutonomy({
        actor,
        reason,
        action: params.action,
        channel: params.channel,
        requesterSenderId: params.requesterSenderId,
      });
      throw new Error(`AAMA policy_gate blocked action: ${reason}`, { cause: error });
    }
  }

  await appendGovernanceEvent({
    lane: "append_only_audit_log",
    eventType: "policy_gate_allow",
    actor,
    details: {
      action: params.action,
      mapped_action_type: actionType,
      channel: params.channel,
      requester_sender_id: params.requesterSenderId ?? null,
    },
  });

  return { decision: "allow", reasons: ["policy gate allow"] };
}

export type EnforceAamaOutboundGuardParams = {
  action: string;
  channel: string;
  payload: Record<string, unknown>;
  alreadyEnforced?: boolean;
  actor?: string | null;
  requesterSenderId?: string | null;
  actionParams?: Record<string, unknown>;
};

export async function enforceAamaOutboundGuard(
  params: EnforceAamaOutboundGuardParams,
): Promise<void> {
  if (params.alreadyEnforced) {
    return;
  }
  await enforceAamaPolicyGateForMessageAction({
    action: params.action,
    channel: params.channel,
    actor: params.actor?.trim() || "system",
    requesterSenderId: params.requesterSenderId ?? undefined,
    actionParams: params.actionParams ?? {},
    payload: params.payload,
  });
}

export async function enforceAamaMemoryGateWrite(
  params: EnforceMemoryWriteParams,
): Promise<AamaMemoryDecision> {
  if (!isAamaPhase1EnforcementEnabled()) {
    return {
      decision: "allow",
      reasons: ["AAMA Phase 1 enforcement disabled"],
      quarantineRequired: false,
      quarantineReasons: [],
      actionBlocked: false,
      escalationRequired: false,
    };
  }

  const actor = params.actor.trim() || "system";
  const config = await loadAamaPhase1Config();
  const schemaErrors = evaluateSchema({ schema: config.memorySchema, record: params.record });
  if (schemaErrors.length > 0) {
    const reason = `memory schema validation failed: ${schemaErrors.join("; ")}`;
    await appendGovernanceEvent({
      lane: "append_only_audit_log",
      eventType: "memory_gate_blocked",
      actor,
      details: {
        reason,
        write_mode: params.writeMode,
      },
    });
    throw new Error(`AAMA memory_gate blocked write: ${reason}`);
  }

  const mode = config.writeControls.memory_write_modes?.[params.writeMode];
  if (!mode || mode.allowed !== true) {
    const reason = `write mode not allowed: ${params.writeMode}`;
    await appendGovernanceEvent({
      lane: "append_only_audit_log",
      eventType: "memory_gate_blocked",
      actor,
      details: { reason, write_mode: params.writeMode },
    });
    throw new Error(`AAMA memory_gate blocked write: ${reason}`);
  }

  const sourceRef =
    typeof params.record.source_ref === "string" ? params.record.source_ref.trim() : "";
  if (mode.requires_source_refs === true && !sourceRef) {
    const reason = "write mode requires source_ref";
    await appendGovernanceEvent({
      lane: "append_only_audit_log",
      eventType: "memory_gate_blocked",
      actor,
      details: { reason, write_mode: params.writeMode },
    });
    throw new Error(`AAMA memory_gate blocked write: ${reason}`);
  }

  if (params.record.integrity_level === "high_impact" && !sourceRef) {
    const reason = "high-impact memory write requires source_ref";
    await appendGovernanceEvent({
      lane: "append_only_audit_log",
      eventType: "memory_gate_blocked",
      actor,
      details: { reason, write_mode: params.writeMode },
    });
    throw new Error(`AAMA memory_gate blocked write: ${reason}`);
  }

  const quarantineReasons: string[] = [];
  const confidence =
    typeof params.record.confidence_score === "number" ? params.record.confidence_score : 0;
  const unresolvedContradiction =
    params.contradictionUnresolved ??
    (Boolean(params.record.contradiction_group_id) &&
      params.record.contradiction_resolved !== true);

  if (params.record.integrity_level === "high_impact" && confidence < 0.85) {
    quarantineReasons.push("confidence < 0.85 for high-impact fact");
  }
  if (unresolvedContradiction) {
    quarantineReasons.push("unresolved contradiction detected");
  }

  const hardLimitDays =
    config.suspensionRules.auto_suspend?.contradiction_backlog_hard_limit_days ?? 14;
  const contradictionAgeDays = params.contradictionAgeDays;
  const actionBlocked = Boolean(
    unresolvedContradiction &&
    typeof contradictionAgeDays === "number" &&
    contradictionAgeDays >= hardLimitDays,
  );
  const escalationRequired = actionBlocked;
  if (actionBlocked) {
    quarantineReasons.push(`contradiction age >= ${hardLimitDays} days`);
  }

  const decision: AamaMemoryDecision = {
    decision: "allow",
    reasons:
      quarantineReasons.length > 0
        ? ["write accepted with quarantine requirements"]
        : ["write allowed"],
    quarantineRequired: quarantineReasons.length > 0,
    quarantineReasons,
    actionBlocked,
    escalationRequired,
  };

  await appendGovernanceEvent({
    lane: "append_only_audit_log",
    eventType: decision.quarantineRequired ? "memory_gate_quarantine" : "memory_gate_allow",
    actor,
    details: {
      write_mode: params.writeMode,
      quarantine_required: decision.quarantineRequired,
      quarantine_reasons: decision.quarantineReasons,
      action_blocked: decision.actionBlocked,
      escalation_required: decision.escalationRequired,
    },
  });

  if (decision.actionBlocked) {
    await appendGovernanceEvent({
      lane: "append_only_audit_log",
      eventType: "council_escalation_required",
      actor: "memory_gate",
      details: {
        reason: "contradiction_backlog_hard_limit_exceeded",
        hard_limit_days: hardLimitDays,
      },
    });
  }

  return decision;
}

export function resetAamaSpineControlsForTests(): void {
  configCache = null;
  sqliteModuleCache = null;
}
