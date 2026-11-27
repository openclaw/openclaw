import type { ConfigValidationIssue, LegacyConfigIssue } from "../config/types.js";
import { createTestConfigSnapshot } from "./test-runtime-config-helpers.js";

export function createDoctorConfigSnapshot(
  params: {
    config?: Record<string, unknown>;
    parsed?: Record<string, unknown>;
    valid?: boolean;
    issues?: ConfigValidationIssue[];
    legacyIssues?: LegacyConfigIssue[];
  } = {},
) {
  const config = params.config ?? {};
  return {
    ...createTestConfigSnapshot(config),
    includedPaths: [],
    parsed: params.parsed ?? {},
    valid: params.valid ?? true,
    issues: params.issues ?? [],
    legacyIssues: params.legacyIssues ?? [],
  };
}
