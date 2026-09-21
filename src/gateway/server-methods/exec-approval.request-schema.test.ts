import { describe, expect, it } from "vitest";
import { validateExecApprovalRequestParams } from "../../../packages/gateway-protocol/src/index.js";

describe("ExecApprovalRequestParams validation", () => {
  const baseParams = {
    command: "echo hi",
    cwd: "/tmp",
    nodeId: "node-1",
    host: "node",
  };

  it.each([
    { label: "omitted", extra: {} },
    { label: "string", extra: { resolvedPath: "/usr/bin/echo" } },
    { label: "undefined", extra: { resolvedPath: undefined } },
    { label: "null", extra: { resolvedPath: null } },
  ])("accepts request with resolvedPath $label", ({ extra }) => {
    const params = { ...baseParams, ...extra };
    expect(validateExecApprovalRequestParams(params)).toBe(true);
  });

  it("accepts unavailable optional decisions", () => {
    expect(
      validateExecApprovalRequestParams({
        ...baseParams,
        unavailableDecisions: ["allow-always"],
      }),
    ).toBe(true);
  });

  it.each(["allow-once", "deny"])("rejects baseline unavailable decision %s", (decision) => {
    expect(
      validateExecApprovalRequestParams({
        ...baseParams,
        unavailableDecisions: [decision],
      }),
    ).toBe(false);
  });
});
