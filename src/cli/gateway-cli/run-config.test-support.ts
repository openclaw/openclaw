import type { ConfigValidationIssue } from "../../config/types.js";
import { OpenClawStateOwnershipMetadataError } from "../../infra/sqlite-lifecycle-errors.js";
import { SqliteSchemaMismatchError } from "../../infra/sqlite-schema-issues.js";

export type RuntimeDotEnvLoadResult = {
  dotenvPresentKeys: string[];
  gatewayEnvAppliedKeys: string[];
  stateEnvAppliedKeys: string[];
};

export function failedGatewayRunConfigSnapshot(
  issues: ConfigValidationIssue[] = [{ path: "<root>", message: "JSON5 parse failed" }],
) {
  return {
    exists: true,
    valid: false,
    path: "/tmp/openclaw-test-missing-config.json",
    config: {},
    sourceConfig: {},
    parsed: null,
    issues,
    legacyIssues: [],
  };
}

type ReadFailureFixture = { label: string; expected: object; exact?: boolean } & (
  | { stage: "read"; failure: Error }
  | { stage: "runtime"; failure: Error }
  | { stage: "snapshot"; snapshot: ReturnType<typeof failedGatewayRunConfigSnapshot> }
);

export function gatewayRunReadFailures(): ReadFailureFixture[] {
  const unavailable = Object.assign(new Error("configuration storage unavailable"), {
    code: "ENOSPC",
  });
  const schema = new SqliteSchemaMismatchError("Stored schema needs repair");
  const ownership = new OpenClawStateOwnershipMetadataError("/synthetic/state.sqlite", "invalid");
  return [
    {
      label: "rejected final read",
      stage: "read",
      failure: unavailable,
      expected: unavailable,
      exact: true,
    },
    {
      label: "unavailable final snapshot",
      stage: "snapshot",
      snapshot: failedGatewayRunConfigSnapshot([
        { path: "", errorCode: "CONFIG_READ_FAILED", message: "read failed: ENOSPC" },
      ]),
      expected: { code: "CONFIG_READ_FAILED" },
    },
    {
      label: "final schema refusal",
      stage: "read",
      failure: schema,
      expected: { code: 78, cause: schema },
    },
    {
      label: "final ownership refusal",
      stage: "read",
      failure: ownership,
      expected: { code: 78, cause: ownership },
    },
    ...[
      { label: "restart schema refusal", failure: schema, code: 78 },
      { label: "restart ownership refusal", failure: ownership, code: 78 },
      { label: "restart unavailable read", failure: unavailable, code: 1 },
    ].map(({ label, failure, code }): ReadFailureFixture => ({
      label,
      failure,
      stage: "runtime",
      expected: { message: `__exit__:${code}` },
    })),
  ];
}
