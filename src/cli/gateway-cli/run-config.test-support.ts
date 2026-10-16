import type { ConfigValidationIssue } from "../../config/types.js";
import { OpenClawStateOwnershipMetadataError } from "../../infra/sqlite-lifecycle-errors.js";

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
      label: "restart ownership refusal",
      failure: ownership,
      stage: "runtime",
      expected: { message: "__exit__:78" },
    },
  ];
}
