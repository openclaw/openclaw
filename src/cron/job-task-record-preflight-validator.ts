import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type Snapshot = {
  name: string;
  version: number;
  literals?: Record<string, string>;
  requiredFields: string[];
  fieldTypes: Record<string, string>; // e.g. "string|null"
};

export type DriftMismatch = {
  field: string;
  expected: string;
  actual: string;
};

export type CronJobTaskRecordValidationResult = {
  verdict: "PASS" | "NEEDS_CHANGES";
  summary: string;
  missingFields: string[];
  drift: DriftMismatch[];
  notes: string[];
};

function loadSnapshot(): Snapshot {
  const snapshotPath = fileURLToPath(
    new URL("./job-task-record-preflight-validator.snapshot.json", import.meta.url),
  );
  const raw = fs.readFileSync(snapshotPath, "utf8");
  return JSON.parse(raw) as Snapshot;
}

function typeCategory(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseExpectedType(expected: string): string[] {
  return expected
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateCronJobTaskRecordPreflight(
  record: JsonRecord,
): CronJobTaskRecordValidationResult {
  const snapshot = loadSnapshot();

  const missingFields: string[] = [];
  const drift: DriftMismatch[] = [];
  const notes: string[] = [];

  // 1) Required-field completeness
  const missingRequiredSet = new Set<string>();
  for (const field of snapshot.requiredFields) {
    const value = record[field];

    if (value === undefined) {
      missingFields.push(field);
      missingRequiredSet.add(field);
      continue;
    }

    const expectedTypeUnion = snapshot.fieldTypes[field];
    const allowed = expectedTypeUnion ? parseExpectedType(expectedTypeUnion) : [];

    // Enforce required fields as BOTH: (a) present and (b) matching expected runtime type.
    if (allowed.includes("string")) {
      if (typeof value !== "string" || value.trim().length === 0) {
        missingFields.push(field);
        missingRequiredSet.add(field);
      }
      continue;
    }

    if (allowed.includes("number")) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        missingFields.push(field);
        missingRequiredSet.add(field);
      }
      continue;
    }

    // Fallback for fields without an expected type definition.
    if (value === null) {
      missingFields.push(field);
      missingRequiredSet.add(field);
    }
  }

  // 2) JSON drift detection vs last-known-good snapshot
  for (const [field, expectedTypeUnion] of Object.entries(snapshot.fieldTypes)) {
    // Only validate drift types when the field is present.
    // Missing required fields are already tracked above.
    if (!(field in record)) continue;
    if (missingRequiredSet.has(field)) continue;

    const value = record[field];
    const actual = typeCategory(value);
    const allowed = parseExpectedType(expectedTypeUnion);

    if (!allowed.includes(actual)) {
      drift.push({ field, expected: expectedTypeUnion, actual });
      continue;
    }

    const literal = snapshot.literals?.[field];
    if (literal !== undefined && value !== literal) {
      drift.push({ field, expected: JSON.stringify(literal), actual: JSON.stringify(value) });
    }
  }

  const verdict: CronJobTaskRecordValidationResult["verdict"] =
    missingFields.length === 0 && drift.length === 0 ? "PASS" : "NEEDS_CHANGES";

  // Deterministic ordering
  missingFields.sort();
  drift.sort((a, b) => a.field.localeCompare(b.field));

  const summary =
    verdict === "PASS"
      ? "PASS: required fields are complete and canonical fields match last-known-good schema snapshot."
      : [
          missingFields.length ? `missing fields: ${missingFields.join(", ")}` : null,
          drift.length
            ? `schema drift: ${drift.map((d) => `${d.field}(${d.expected}→${d.actual})`).join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join("; ");

  if (verdict === "NEEDS_CHANGES") {
    if (missingFields.length) {
      notes.push(`Missing required fields: ${missingFields.join(", ")}`);
    }
    if (drift.length) {
      notes.push(
        `Schema drift vs last-known-good snapshot (${snapshot.name}):\n` +
          drift.map((d) => `- ${d.field}: expected ${d.expected}, got ${d.actual}`).join("\n"),
      );
    }
  } else {
    notes.push(`Validated target: ${snapshot.name} (v${snapshot.version}).`);
  }

  // Always include a compact PASS/FAIL evidence line in notes.
  notes.push(
    `Result: ${verdict} (${missingFields.length} missing, ${drift.length} drift mismatch${drift.length === 1 ? "" : "es"}).`,
  );

  return {
    verdict,
    summary,
    missingFields,
    drift,
    notes,
  };
}
