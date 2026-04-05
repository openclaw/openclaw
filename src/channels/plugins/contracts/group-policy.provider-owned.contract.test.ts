import { describe, expect, it } from "vitest";
import { evaluateZaloGroupAccess } from "../../../../extensions/zalo/test-api.js";

function expectAllowedZaloGroupAccess(params: Parameters<typeof evaluateZaloGroupAccess>[0]) {
  expect(evaluateZaloGroupAccess(params)).toMatchObject({
    allowed: true,
    groupPolicy: "allowlist",
    reason: "allowed",
  });
}

function expectAllowedZaloGroupAccessCase(
  params: Omit<Parameters<typeof evaluateZaloGroupAccess>[0], "groupAllowFrom"> & {
    groupAllowFrom: readonly string[];
  },
) {
  expectAllowedZaloGroupAccess({
    ...params,
    groupAllowFrom: [...params.groupAllowFrom],
  });
}

describe("channel runtime group policy provider-owned contract", () => {
  describe("zalo", () => {
    it.each([
      {
        providerConfigPresent: true,
        configuredGroupPolicy: "allowlist",
        defaultGroupPolicy: "open",
        groupAllowFrom: ["zl:12345"],
        senderId: "12345",
      },
    ] as const)("keeps provider-owned group access evaluation %#", (testCase) => {
      expectAllowedZaloGroupAccessCase(testCase);
    });
  });
});
