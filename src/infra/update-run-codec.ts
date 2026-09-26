import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { UpdateRuns } from "../state/openclaw-state-db.generated.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { normalizeUpdateFailureFacts } from "./update-failure-facts.js";
import { UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";

const JSON_BYTES = 16 * 1024;
const RETAINED_STEP_NAMES = [
  ...UPDATE_RUN_PHASES,
  "notice:ack",
  "notice:activating",
  "notice:verifying",
  "previous generation restoration",
  "post-update verification",
  "task-delivery-recovery",
  "driver:adopted",
  "driver:identity-unavailable",
  "reconcile:abandoned",
  "reconcile:superseded",
  "reconcile:acknowledged",
  "reconcile:settle",
];
export type UpdateRunLedgerOptions = OpenClawStateDatabaseOptions & {
  busyTimeoutMs?: number;
  redactPaths?: readonly string[];
};

function mapJsonText(
  value: unknown,
  transform: (text: string, key?: string) => string,
  key?: string,
): unknown {
  if (typeof value === "string") {
    return transform(value, key);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapJsonText(entry, transform, key));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((field) => [field, mapJsonText(value[field], transform, field)]),
    );
  }
  return value;
}

export function isRetainedStep(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item.step === "string" &&
    (item.step.startsWith("finalize:") || RETAINED_STEP_NAMES.some((name) => name === item.step))
  );
}

/** Phase history, notice custody, and restoration proof survive diagnostic eviction. */
function boundedJson(
  input: unknown,
  maxBytes = JSON_BYTES,
  preservedTextFields?: ReadonlySet<string>,
): string {
  let value = input;
  let json = JSON.stringify(value);
  while (Buffer.byteLength(json) > maxBytes) {
    if (Array.isArray(value)) {
      const disposable = value.findIndex((item) => !isRetainedStep(item));
      if (disposable >= 0) {
        value = value.toSpliced(disposable, 1);
      } else {
        // Recovery details are the durable backup receipt, not optional diagnostics.
        const compacted = value.map((item) =>
          isRecord(item) &&
          item.step !== "task-delivery-recovery" &&
          !(typeof item.step === "string" && item.step.startsWith("finalize:doctor-lint:"))
            ? { ...item, detail: undefined, failureFacts: undefined }
            : item,
        );
        if (JSON.stringify(compacted) === json) {
          throw new Error("Update run retained step metadata exceeds its byte limit");
        }
        value = compacted;
      }
    } else if (isRecord(value)) {
      const object = value;
      const arrayField = Object.keys(object)
        .toSorted()
        .find((field) => Array.isArray(object[field]) && object[field].length > 0);
      const array = arrayField ? object[arrayField] : undefined;
      if (arrayField && Array.isArray(array)) {
        value = { ...object, [arrayField]: array.slice(1) };
      } else {
        value = mapJsonText(value, (text, key) =>
          key && preservedTextFields?.has(key)
            ? text
            : truncateUtf16Safe(text, Math.floor(text.length / 2)),
        );
      }
    } else {
      throw new Error("Update run metadata exceeds its bounded schema");
    }
    const nextJson = JSON.stringify(value);
    if (nextJson === json) {
      throw new Error("Update run retained metadata exceeds its byte limit");
    }
    json = nextJson;
  }
  return json;
}

function boundedOriginJson(origin: UpdateRunRecord["origin"]): string {
  const {
    driver,
    previousDrivers,
    updateRecoveryCapture,
    requester,
    sessionKey,
    deliveryContext,
    campaignId,
    ...admissionDiagnostics
  } = origin;
  // Operational receipts are not expendable diagnostics. Keep them exact inside
  // the existing database byte budget; oversized sets fail before replacing a row.
  const retained = JSON.stringify({ driver, previousDrivers, updateRecoveryCapture });
  if (Buffer.byteLength(retained) > JSON_BYTES) {
    throw new Error("Update run recovery receipts exceed the origin byte limit");
  }
  const routing = { requester, sessionKey, deliveryContext, campaignId };
  const hasAdmission = origin.admission !== undefined || origin.candidateAdmission !== undefined;
  // Admission diagnostics cannot shorten routing; both yield to recovery receipts.
  const identities = hasAdmission
    ? JSON.stringify({ driver, previousDrivers, updateRecoveryCapture, ...routing })
    : retained;
  const diagnostics = hasAdmission ? admissionDiagnostics : { ...admissionDiagnostics, ...routing };
  // Merging removes the diagnostic braces and needs a comma only when identities exist.
  const diagnosticBudget =
    JSON_BYTES - Buffer.byteLength(identities) + 2 - (identities === "{}" ? 0 : 1);
  if (
    diagnostics.candidateAdmission?.warnings.length &&
    Buffer.byteLength(JSON.stringify(diagnostics)) > diagnosticBudget
  ) {
    diagnostics.candidateAdmission = { ...diagnostics.candidateAdmission, warnings: [] };
  }
  const preservedTextFields = new Set([
    "owner",
    "verdict",
    "status",
    "code",
    "name",
    "candidateVersion",
    "installedVersion",
    "fallbackReason",
  ]);
  const minimumDiagnostics = JSON.stringify(
    mapJsonText(diagnostics, (text, key) => (key && preservedTextFields.has(key) ? text : "")),
  );
  if (Buffer.byteLength(minimumDiagnostics) > diagnosticBudget) {
    return retained;
  }
  const boundedDiagnostics = boundedJson(diagnostics, diagnosticBudget, preservedTextFields);
  return `{${[identities.slice(1, -1), boundedDiagnostics.slice(1, -1)].filter(Boolean).join(",")}}`;
}

export function encodeRun(input: UpdateRunRecord, options: UpdateRunLedgerOptions): UpdateRuns {
  const env = options.env ?? process.env;
  // Home-relative selectors remain actionable in reports. Other captured roots
  // are diagnostic only; model refs, slash commands, and URLs are not paths.
  const roots: [string | undefined, string][] = [
    [resolveRequiredHomeDir(env), "~"],
    [env.HOME, "~"],
    [env.USERPROFILE, "~"],
    [resolveStateDir(env), "$OPENCLAW_STATE_DIR"],
    [env.OPENCLAW_CONFIG_PATH, "[path]"],
    ...(options.redactPaths ?? []).map((root): [string, string] => [root, "[path]"]),
  ];
  const redactPaths: [RegExp, string][] = roots.flatMap(([root, replacement]) => {
    if (!root) {
      return [];
    }
    const prefix = root
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "")
      .split("/")
      .map(escapeRegExp)
      .join("[\\\\/]");
    const flags = /^(?:[A-Za-z]:|\\\\)/u.test(root) ? "giu" : "gu";
    return prefix
      ? [
          [
            new RegExp(
              `(?<!https?:)(?:(?<![\\w/])|(?<=file:///?))${prefix}(?=$|[\\\\/\\s"'<>.,;:)])`,
              flags,
            ),
            replacement,
          ],
        ]
      : [];
  });
  // Process identities and recovery receipts are operational facts, not diagnostics.
  const { driver, previousDrivers, updateRecoveryCapture, ...originDiagnostics } = input.origin;
  const record = UpdateRunRecordSchema.parse(
    mapJsonText(
      {
        ...input,
        origin: originDiagnostics,
        steps: input.steps.map((step) => ({
          ...step,
          ...(step.failureFacts
            ? { failureFacts: normalizeUpdateFailureFacts(step.failureFacts, env) }
            : {}),
        })),
      },
      (value) => {
        let text = redactSensitiveText(value, { mode: "tools" });
        for (const [pattern, replacement] of redactPaths) {
          text = text.replace(pattern, () => replacement);
        }
        return truncateUtf16Safe(text, UPDATE_RUN_TEXT_LIMIT);
      },
    ),
  );
  record.origin = UpdateRunRecordSchema.shape.origin.parse({
    ...record.origin,
    driver,
    previousDrivers,
    updateRecoveryCapture,
  });
  return {
    run_id: record.runId,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
    trigger: record.trigger,
    phase: record.phase,
    status: record.status,
    reason: record.reason,
    origin_json: boundedOriginJson(record.origin),
    target_json: boundedJson(record.target),
    before_json: boundedJson(record.before),
    after_json: boundedJson(record.after),
    steps_json: boundedJson(record.steps),
    verification_json: boundedJson(record.verification),
    repair_json: boundedJson(record.repair),
    confirmed_at_ms: record.confirmedAtMs,
    finished_at_ms: record.finishedAtMs,
    downtime_ms: record.downtimeMs,
  };
}
