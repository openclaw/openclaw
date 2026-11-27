import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import type { UpdateRuns } from "../state/openclaw-state-db.generated.js";
import { parseDoctorRetirementWideningLine } from "./doctor-progress.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { normalizeUpdateFailureFacts } from "./update-failure-facts.js";
import { UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type { UpdateRunRedactionFacts } from "./update-run-mutation.types.js";
import { getUpdateRunOmittedStepCount, UPDATE_RUN_TRUNCATED_STEP } from "./update-run-omission.js";
import { isUpdateOwedStepRow } from "./update-run-owed-step.js";
import { toUpdateRunDriver, type UpdateRunRecord } from "./update-run-record.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";

const JSON_BYTES = 16 * 1024;
/** Plugin rollback kept a later writer's value; users review it through Doctor. */
export const PLUGIN_COHORT_KEPT_WARNING_STEP = "warning:plugin-cohort:later-changes-kept";
/** A replaced package directory's successor settled the run's plugin recovery. */
const PLUGIN_COHORT_REPLACED_INSTALLATION_STEP = "warning:plugin-cohort:replaced-installation";
const RETAINED_STEP_NAMES = [
  ...UPDATE_RUN_PHASES,
  "candidate-admission",
  // Keep named admission/lifecycle receipts, not the unbounded warning:* namespace.
  "warning:update-admission-unsupported-target",
  "warning:update-admission-fallback",
  "warning:managed-service-membership",
  "warning:finalize:plugins:deadline",
  "global update",
  "global update (omit optional)",
  // Phase timing that explains long validating and activation windows.
  "candidate-state-snapshot",
  "candidate-doctor",
  "candidate-doctor-lint",
  "updater-runtime-retention",
  "diagnostic:updater-runtime-retention",
  "candidate-gateway-startup",
  "candidate-state-cleanup",
  "post-stop-checks",
  "warning:post-stop-checks",
  "git-checkout",
  "git-runtime-activation",
  "openclaw doctor",
  "pre-plugin doctor",
  "post-plugin doctor",
  // Doctor sections lead each Doctor's diagnostics; compaction may still drop their detail.
  "diagnostic:candidate-doctor",
  "diagnostic:openclaw doctor",
  "diagnostic:pre-plugin doctor",
  "diagnostic:post-plugin doctor",
  // A later warning flood must not hide that post-update repair never ran.
  "warning:post-plugin doctor",
  "managed-service-executor-check",
  "managed-service-install",
  "managed-service-restart",
  "managed-service update handoff",
  "warning:managed-service-reconciliation",
  "service-stop",
  "service-start",
  "service-running",
  "update-driver-handoff",
  "diagnostic:update-driver-handoff",
  "notice:ack",
  "notice:activating",
  "notice:verifying",
  "previous generation restoration",
  "post-update verification",
  "diagnostic:database snapshot",
  "diagnostic:database migration writes",
  "warning:database migration writes",
  "diagnostic:database rollback",
  "task-delivery-recovery",
  "driver:adopted",
  "driver:identity-unavailable",
  "reconcile:abandoned",
  "reconcile:superseded",
  "reconcile:acknowledged",
  "reconcile:settle",
  "warning:reconcile:driver-lost-after-verification",
  "recovery-artifact-cleanup",
  "warning:recovery-artifact-cleanup",
  "diagnostic:recovery-artifact-cleanup",
  PLUGIN_COHORT_KEPT_WARNING_STEP,
  PLUGIN_COHORT_REPLACED_INSTALLATION_STEP,
];
export type UpdateRunLedgerOptions = OpenClawStateDatabaseOptions & {
  busyTimeoutMs?: number;
  /** One-shot bookkeeping under the candidate Doctor capture, before native migration. */
  attributeUpdateWrite?: true;
  redactPaths?: readonly string[];
};

/** Capture only path redaction facts; the state worker keeps its own authority environment. */
export function captureUpdateRunRedactionFacts(
  env: NodeJS.ProcessEnv = process.env,
): UpdateRunRedactionFacts {
  return {
    effectiveHome: resolveRequiredHomeDir(env),
    home: env.HOME,
    userProfile: env.USERPROFILE,
    configPath: env.OPENCLAW_CONFIG_PATH,
  };
}

export function resolveUpdateRunCodecEnv(
  stateEnv: NodeJS.ProcessEnv | undefined,
  facts: UpdateRunRedactionFacts,
): NodeJS.ProcessEnv {
  return {
    ...(stateEnv ?? process.env),
    OPENCLAW_HOME: facts.effectiveHome,
    HOME: facts.home,
    USERPROFILE: facts.userProfile,
    OPENCLAW_CONFIG_PATH: facts.configPath,
  };
}

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

function compactConfigWriteRefusal(
  value: RunStep["configWriteRefusal"],
): RunStep["configWriteRefusal"] {
  if (!value?.keys.some((key) => key.length > 0)) {
    return undefined;
  }
  return {
    ...value,
    keys: value.keys.map((key) => truncateUtf16Safe(key, Math.floor(key.length / 2))),
  };
}

type RunSteps = UpdateRunRecord["steps"];
type RunStep = RunSteps[number];

function isRetainedStep(item: RunStep): boolean {
  return (
    item.termination === "signal" ||
    item.step === UPDATE_RUN_TRUNCATED_STEP ||
    item.step.startsWith("finalize:") ||
    RETAINED_STEP_NAMES.some((name) => name === item.step) ||
    (item.step.startsWith("diagnostic:") &&
      typeof item.detail === "string" &&
      parseDoctorRetirementWideningLine(item.detail) !== undefined)
  );
}

function isActionableStep(item: RunStep): boolean {
  return (
    item.status === "failed" ||
    item.step.startsWith("warning:") ||
    isUpdateOwedStepRow(item.step) ||
    item.step === "reconcile:settle"
  );
}

/** Informational rows yield first. Failed steps outlast ordinary warnings. */
export function findEvictableStep(steps: readonly RunStep[], allowActionable = false): number {
  const disposable = steps.findIndex((step) => !isRetainedStep(step) && !isActionableStep(step));
  if (disposable >= 0 || !allowActionable) {
    return disposable;
  }
  const warning = steps.findIndex((step) => !isRetainedStep(step) && step.status !== "failed");
  return warning >= 0 ? warning : steps.findIndex((step) => !isRetainedStep(step));
}

export function omitUpdateRunStep(steps: RunSteps, index: number): void {
  steps.splice(index, 1);
  const count = getUpdateRunOmittedStepCount(steps);
  const markerIndex = steps.findIndex(({ step }) => step === UPDATE_RUN_TRUNCATED_STEP);
  const marker: RunStep = {
    step: UPDATE_RUN_TRUNCATED_STEP,
    status: "completed",
    detail: String(count + 1),
  };
  if (markerIndex >= 0) {
    steps[markerIndex] = marker;
  } else {
    steps.push(marker);
  }
}

function compactStepDetail(item: RunStep): RunStep {
  // Recovery details are durable receipts, not expendable diagnostic output.
  if (
    item.step === UPDATE_RUN_TRUNCATED_STEP ||
    isUpdateOwedStepRow(item.step) ||
    item.termination === "signal" ||
    item.step === "task-delivery-recovery" ||
    item.step === "diagnostic:database snapshot" ||
    item.step === "diagnostic:database migration writes" ||
    item.step === "diagnostic:database rollback" ||
    item.step === "finalize:data-at-risk" ||
    item.step.startsWith("finalize:doctor-lint:") ||
    (typeof item.detail === "string" && parseDoctorRetirementWideningLine(item.detail))
  ) {
    return item;
  }
  return {
    ...item,
    ...(isActionableStep(item) ? {} : { detail: undefined, failureFacts: undefined }),
    // Keep the refusal but bound its key inventory, including on a failed Doctor row.
    configWriteRefusal: compactConfigWriteRefusal(item.configWriteRefusal),
  };
}

function boundedStepsJson(input: RunSteps): string {
  let steps = [...input];
  let json = JSON.stringify(steps);
  while (Buffer.byteLength(json) > JSON_BYTES) {
    const disposable = findEvictableStep(steps);
    if (disposable >= 0) {
      omitUpdateRunStep(steps, disposable);
    } else {
      // Shed non-actionable detail before evicting advice.
      const compacted = steps.map(compactStepDetail);
      const compactedJson = JSON.stringify(compacted);
      if (compactedJson !== json) {
        steps = compacted;
        json = compactedJson;
        continue;
      }
      // Native output is diagnostic. Shorten it before giving up on useful rows.
      const outputIndex = steps.findLastIndex((entry) => Boolean(entry.stderrTail));
      if (outputIndex >= 0) {
        const entry = steps[outputIndex]!;
        const stderr = entry.stderrTail!;
        steps[outputIndex] = {
          ...entry,
          stderrTail: truncateUtf16Safe(stderr, Math.floor(stderr.length / 2)),
        };
      } else {
        const overflow = findEvictableStep(steps, true);
        if (overflow < 0) {
          throw new Error("Update run retained step metadata exceeds its byte limit");
        }
        omitUpdateRunStep(steps, overflow);
      }
    }
    json = JSON.stringify(steps);
  }
  return json;
}

function boundedJson(
  input: unknown,
  maxBytes = JSON_BYTES,
  preservedTextFields?: ReadonlySet<string>,
): string {
  let value = input;
  let json = JSON.stringify(value);
  while (Buffer.byteLength(json) > maxBytes) {
    if (Array.isArray(value)) {
      // Repair attempts stay chronological and do not use the step omission marker.
      value = value.slice(1);
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

/**
 * Driver boot namespaces only let a later update skip a repair after a restart. They
 * yield before recovery receipts fail or admission identities and routing are evicted;
 * diagnostic text is still shortened first. A run without them keeps explicit repair.
 */
function boundedOriginJson(origin: UpdateRunRecord["origin"]): string {
  const json = boundedOriginJsonWithNamespaces(origin);
  if (json !== undefined) {
    return json;
  }
  const { driver, previousDrivers } = origin;
  return (
    boundedOriginJsonWithNamespaces({
      ...origin,
      driver: driver && toUpdateRunDriver(driver),
      previousDrivers: previousDrivers?.map(toUpdateRunDriver),
    }) ?? throwOversizedReceipts()
  );
}

function throwOversizedReceipts(): never {
  throw new Error("Update run recovery receipts exceed the origin byte limit");
}

/** Undefined when receipts or admission identities do not fit beside namespaces. */
function boundedOriginJsonWithNamespaces(origin: UpdateRunRecord["origin"]): string | undefined {
  const hasNamespaces = [origin.driver, ...(origin.previousDrivers ?? [])].some(
    (driver) => driver?.namespace !== undefined,
  );
  const {
    driver,
    previousDrivers,
    updateRecoveryCapture,
    managedHandoff,
    packageStage,
    packageRelease,
    gitActivation,
    windowsUserSid,
    requester,
    sessionKey,
    deliveryContext,
    campaignId,
    ...admissionDiagnostics
  } = origin;
  // Operational receipts are not expendable diagnostics. Keep them exact inside
  // the existing database byte budget; oversized sets fail before replacing a row.
  const retained = JSON.stringify({
    driver,
    previousDrivers,
    updateRecoveryCapture,
    managedHandoff,
    packageStage,
    packageRelease,
    gitActivation,
    windowsUserSid,
  });
  if (Buffer.byteLength(retained) > JSON_BYTES) {
    return hasNamespaces ? undefined : throwOversizedReceipts();
  }
  const routing = { requester, sessionKey, deliveryContext, campaignId };
  const hasAdmission =
    origin.admission !== undefined ||
    origin.candidateAdmission !== undefined ||
    origin.releaseAdmission !== undefined;
  // Admission diagnostics cannot shorten routing; both yield to recovery receipts.
  const identities = hasAdmission
    ? JSON.stringify({
        driver,
        previousDrivers,
        updateRecoveryCapture,
        managedHandoff,
        packageStage,
        packageRelease,
        gitActivation,
        windowsUserSid,
        ...routing,
      })
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
    // A closed enum: halving it would make the stored record fail validation on read.
    "cause",
  ]);
  const minimumDiagnostics = JSON.stringify(
    mapJsonText(diagnostics, (text, key) => (key && preservedTextFields.has(key) ? text : "")),
  );
  if (Buffer.byteLength(minimumDiagnostics) > diagnosticBudget) {
    return hasNamespaces ? undefined : retained;
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
  const {
    driver,
    previousDrivers,
    updateRecoveryCapture,
    managedHandoff,
    packageStage,
    packageRelease,
    gitActivation,
    windowsUserSid,
    ...originDiagnostics
  } = input.origin;
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
      (value, key) => {
        let text = redactSensitiveText(value, { mode: "tools" });
        for (const [pattern, replacement] of redactPaths) {
          text = text.replace(pattern, () => replacement);
        }
        return truncateUtf16Safe(text, key === "stderrTail" ? 8192 : UPDATE_RUN_TEXT_LIMIT);
      },
    ),
  );
  record.origin = UpdateRunRecordSchema.shape.origin.parse({
    ...record.origin,
    driver,
    previousDrivers,
    updateRecoveryCapture,
    managedHandoff,
    packageStage,
    packageRelease,
    gitActivation,
    windowsUserSid,
  });
  // Shipped readers parse recovery strictly. Its named risk lives in a retained step fact.
  if (record.verification.recovery?.serviceRestartSafe === false) {
    delete record.verification.recovery.dataAtRisk;
  }
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
    steps_json: boundedStepsJson(record.steps),
    verification_json: boundedJson(record.verification),
    repair_json: boundedJson(record.repair),
    confirmed_at_ms: record.confirmedAtMs,
    finished_at_ms: record.finishedAtMs,
    downtime_ms: record.downtimeMs,
  };
}
