import { expect, it } from "vitest";
import { validateExecApprovalRequestParams } from "../../../packages/gateway-protocol/src/index.js";

it("accepts an unresolved exec approval path", () => {
  expect(validateExecApprovalRequestParams({ command: "echo hi", resolvedPath: null })).toBe(true);
});
