// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import {
  isMissingOperatorReadScopeError,
  isWizardNotFoundError,
  isSetupAdmissionBusyError,
} from "./gateway-errors.ts";

function requestError(code: string, message: string, details?: Record<string, unknown>) {
  return new GatewayRequestError({ code, message, details });
}
function missingScope(scope: string, message = `missing scope: ${scope}`) {
  return requestError("FORBIDDEN", message, {
    code: "MISSING_SCOPE",
    missingScope: scope,
    requiredScopes: [scope],
  });
}
const classifiers = [
  [isWizardNotFoundError, "INVALID_REQUEST", "WIZARD_NOT_FOUND", "UNAVAILABLE"],
  [isSetupAdmissionBusyError, "UNAVAILABLE", "SETUP_ADMISSION_BUSY", "INVALID_REQUEST"],
] as const;

describe("gateway error helpers", () => {
  it.each(classifiers)(
    "classifies structured %s %s %s without parsing copy",
    (classify, code, detailCode) => {
      const details = { code: detailCode };
      expect(classify(requestError(code, "localized or changed public copy", details))).toBe(true);
      expect(classify({ gatewayCode: code, details })).toBe(true);
    },
  );

  it.each(classifiers)(
    "rejects unrelated %s %s %s %s errors",
    (classify, code, detailCode, wrongCode) => {
      expect(classify({ gatewayCode: wrongCode, details: { code: detailCode } })).toBe(false);
      expect(classify({ gatewayCode: code, details: { code: "UNKNOWN_AGENT_ID" } })).toBe(false);
      expect(classify({ gatewayCode: code, message: "wizard not found" })).toBe(false);
      for (const details of [null, detailCode, [], { code: 42 }]) {
        expect(classify({ gatewayCode: code, details })).toBe(false);
      }
    },
  );

  it.each([
    ["structured read scope", missingScope("operator.read", "permission denied"), true],
    [
      "shared client message",
      requestError("INVALID_REQUEST", "missing scope: operator.read"),
      true,
    ],
    [
      "connect authorization",
      requestError("INVALID_REQUEST", "unauthorized", { code: "AUTH_UNAUTHORIZED" }),
      false,
    ],
    ["another scope", missingScope("operator.questions"), false],
  ] as const)(
    "classifies %s independently of unrelated authorization failures",
    (_name, error, expected) => {
      expect(isMissingOperatorReadScopeError(error)).toBe(expected);
    },
  );
});
