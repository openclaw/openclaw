import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as installRecordSchema from "./provenance-schema-version.js";
import type { ClawAgentOrigin } from "./provenance-schema-version.js";
import type { ClawAddPlan } from "./types.js";

function ownedPathList(payload: unknown): string[] | undefined {
  return Array.isArray(payload) && payload.every((path) => typeof path === "string")
    ? payload
    : undefined;
}

function adoptedOwnership(payload: unknown): { paths: string[]; claimed: boolean } | undefined {
  if (!isRecord(payload) || Array.isArray(payload)) {
    return undefined;
  }
  const paths = payload.origin === "adopted" ? ownedPathList(payload.paths) : undefined;
  if (!paths || (payload.claimed !== undefined && typeof payload.claimed !== "boolean")) {
    return undefined;
  }
  // v3 records created before claim provenance was introduced represent completed adoptions.
  return { paths, claimed: payload.claimed ?? true };
}

export function decodeClawAgentOwnership(schemaValue: string, payloadJson: string) {
  const schemaVersion = installRecordSchema.parseClawInstallRecordSchemaVersion(schemaValue);
  const payload = JSON.parse(payloadJson) as unknown;
  const adopted = schemaVersion === installRecordSchema.CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION;
  const adoptedValue = adopted ? adoptedOwnership(payload) : undefined;
  const paths = adopted ? adoptedValue?.paths : ownedPathList(payload);
  if (!paths || (adopted && !adoptedValue)) {
    throw new Error(
      `Invalid Claw agent ownership payload for schema ${JSON.stringify(schemaVersion)}.`,
    );
  }
  return {
    schemaVersion,
    origin: adopted ? ("adopted" as const) : ("created" as const),
    paths,
    claimed: adoptedValue?.claimed ?? true,
  };
}

export function clawAgentOrigin(plan: ClawAddPlan): ClawAgentOrigin {
  return plan.actions.some((action) => action.kind === "agent" && action.action === "adopt")
    ? "adopted"
    : "created";
}

export function encodeClawAgentOwnership(origin: ClawAgentOrigin, paths: string[], claimed = true) {
  return origin === "adopted"
    ? {
        schemaVersion: installRecordSchema.CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
        payload: { origin, paths, claimed },
      }
    : { schemaVersion: installRecordSchema.CLAW_INSTALL_RECORD_SCHEMA_VERSION, payload: paths };
}

export function clawAgentOwnershipPayloadCandidates(
  origin: ClawAgentOrigin,
  paths: string[],
  claimed = true,
): unknown[] {
  const canonical = encodeClawAgentOwnership(origin, paths, claimed).payload;
  return origin === "adopted" && claimed
    ? [canonical, { origin: "adopted" as const, paths }]
    : [canonical];
}
