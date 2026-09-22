import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";

export const LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX =
  "idx_skill_workshop_collection_reviews_workspace_time";

type OpenClawStateDatabaseSchemaMigrationRequiredKind =
  | "agent-databases-composite-primary-key"
  | "audit-events-v2"
  | "legacy-workshop-review-index";

export class OpenClawStateDatabaseSchemaMigrationRequiredError extends StartupMaintenanceRequiredError {
  constructor(
    override readonly kind: OpenClawStateDatabaseSchemaMigrationRequiredKind,
    readonly pathname: string,
  ) {
    super(
      kind,
      `OpenClaw state database schema migration required (${kind}) at ${pathname}; run openclaw doctor --fix to migrate it.`,
    );
    this.name = "OpenClawStateDatabaseSchemaMigrationRequiredError";
  }
}

/** Runtime readers report malformed legacy state without entering repair mode. */
export function normalizeOpenClawStateSchemaReadError(error: unknown, pathname: string): unknown {
  if (
    error instanceof Error &&
    error.message.startsWith(
      `malformed database schema (${LEGACY_SKILL_WORKSHOP_COLLECTION_REVIEWS_INDEX})`,
    )
  ) {
    const required = new OpenClawStateDatabaseSchemaMigrationRequiredError(
      "legacy-workshop-review-index",
      pathname,
    );
    required.cause = error;
    return required;
  }
  return error;
}
