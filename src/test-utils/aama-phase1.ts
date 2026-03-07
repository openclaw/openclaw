import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type FixtureOptions = {
  root: string;
  appendOnlyAllowed?: boolean;
};

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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64UrlEncode(raw: Buffer): string {
  return raw.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export async function writeAamaPhase1Fixture(options: FixtureOptions): Promise<void> {
  const root = options.root;
  await fs.mkdir(path.join(root, "core"), { recursive: true });
  await fs.mkdir(path.join(root, "policy"), { recursive: true });
  await fs.mkdir(path.join(root, "memory", "schema"), { recursive: true });
  await fs.mkdir(path.join(root, "governance", "spine", "append_only_audit_log"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "governance", "spine", "attestation_events"), {
    recursive: true,
  });

  await fs.writeFile(
    path.join(root, "core", "approval_rules.yaml"),
    [
      "version: 1",
      "authority_model:",
      "  tiffany:",
      '    role: "primary_operator"',
      "    approves:",
      "      - send_external_message",
      "      - external_followup_send",
      "      - client_facing_campaign_send",
      "  christian:",
      '    role: "owner_governance"',
      "    approves:",
      "      - promote_to_tier3",
      "      - governance_root_changes",
      "      - token_service_trust_boundary_changes",
      "      - policy_gate_rule_changes",
      "  self_authorized_by_tier:",
      "    - internal_draft_generation",
      "    - reflection_capture",
      "    - hygiene_dedupe_scan",
      "    - read_only_retrieval",
      "constraints:",
      "  approval_token_required_for_external_send: true",
      "  send_external_allowlist_bypass: false",
      "  ambiguous_default_approver_allowed: false",
      "",
    ].join("\n"),
    "utf-8",
  );

  const appendAllowed = options.appendOnlyAllowed !== false;
  await fs.writeFile(
    path.join(root, "policy", "write_controls.yaml"),
    [
      "version: 1",
      "memory_write_modes:",
      "  append_only:",
      `    allowed: ${appendAllowed ? "true" : "false"}`,
      "    approval_required: false",
      "  merge_with_trace:",
      "    allowed: true",
      "    approval_required: false",
      "    requires_source_refs: true",
      "  replace_guarded:",
      "    allowed: true",
      "    approval_required: true",
      "",
    ].join("\n"),
    "utf-8",
  );

  await fs.writeFile(
    path.join(root, "policy", "suspension_rules.yaml"),
    [
      "version: 1",
      "auto_suspend:",
      "  high_severity_policy_violations_7d: 2",
      "  unauthorized_external_action: 1",
      "  approval_token_bypass: 1",
      "  contradiction_backlog_hard_limit_days: 14",
      "  noise_budget_breach_consecutive_weeks: 2",
      "",
    ].join("\n"),
    "utf-8",
  );

  await fs.writeFile(
    path.join(root, "memory", "schema", "memory_schema_v1.json"),
    JSON.stringify(
      {
        type: "object",
        additionalProperties: false,
        required: [
          "memory_id",
          "memory_class",
          "module",
          "entity_ref",
          "payload",
          "source_ref",
          "confidence_score",
          "created_at",
          "updated_at",
          "status",
          "retention_policy",
          "created_by",
          "review_required",
          "quarantine_state",
          "contradiction_group_id",
          "integrity_level",
        ],
        properties: {
          memory_id: { type: "string" },
          memory_class: {
            type: "string",
            enum: ["permanent", "long_term", "active", "reflection", "idea", "archive"],
          },
          module: {
            type: "string",
            enum: [
              "client",
              "deal",
              "manufacturer",
              "competitor",
              "design",
              "marketing",
              "reflection",
              "idea",
            ],
          },
          entity_ref: { type: "string" },
          payload: { type: "object" },
          source_ref: { type: "string" },
          confidence_score: { type: "number", minimum: 0, maximum: 1 },
          created_at: { type: "string" },
          updated_at: { type: "string" },
          status: { type: "string", enum: ["active", "stale", "archived", "superseded"] },
          retention_policy: { type: "string" },
          created_by: { type: "string", enum: ["human", "agent", "system"] },
          review_required: { type: "boolean" },
          quarantine_state: { type: "string", enum: ["none", "pending_review", "blocked"] },
          contradiction_group_id: { type: ["string", "null"] },
          integrity_level: { type: "string", enum: ["normal", "high_impact"] },
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  await fs.writeFile(
    path.join(root, "governance", "spine", "append_only_audit_log", "events.jsonl"),
    "",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "governance", "spine", "attestation_events", "events.jsonl"),
    "",
    "utf-8",
  );
}

export function issueAamaApprovalToken(params: {
  secret: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  nonce: string;
  approver?: string;
  issuedAt?: number;
  ttlSeconds?: number;
}): string {
  const issuedAt = params.issuedAt ?? Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds ?? 900;
  const claims = {
    jti: crypto.randomUUID(),
    actor: params.actor,
    action_type: params.actionType,
    payload_hash: sha256(stableStringify(params.payload)),
    nonce: params.nonce,
    iat: issuedAt,
    exp: issuedAt + ttl,
    approver: params.approver ?? "tiffany",
  };
  const header = { alg: "HS256", typ: "AAMA-APPROVAL" };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(claims)));
  const signature = crypto
    .createHmac("sha256", params.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const signatureB64 = base64UrlEncode(signature);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
