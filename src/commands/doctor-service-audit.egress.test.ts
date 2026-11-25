import { describe, expect, it } from "vitest";
import { SERVICE_AUDIT_CODES } from "../daemon/service-audit.js";
import {
  hasRepairableServiceDefinitionDrift,
  isOperatorOwnedServiceIssue,
  isServiceDefinitionOnlyRepair,
} from "./doctor-service-audit.js";

describe("Doctor temporary egress environment repair", () => {
  const issue = {
    code: SERVICE_AUDIT_CODES.gatewayEgressProxyEnvEmbedded,
    environmentKeys: ["NODE_EXTRA_CA_CERTS"],
    message: "temporary egress trust",
  };
  const audit = {
    ok: false,
    issues: [issue],
    definitionDrift: [
      {
        kind: "outdated" as const,
        key: "Environment.NODE_EXTRA_CA_CERTS",
        current: "<process-owned>",
        expected: "<removed>",
        message: "temporary egress trust",
      },
    ],
  };

  it("allows --fix through the existing definition-repair policy", () => {
    expect(hasRepairableServiceDefinitionDrift(audit)).toBe(true);
    expect(isServiceDefinitionOnlyRepair(audit)).toBe(true);
  });

  it("keeps operator drop-ins outside the managed repair", () => {
    expect(
      isOperatorOwnedServiceIssue(
        issue,
        {
          programArguments: ["node", "gateway"],
          managedOverrides: { environment: { keys: ["NODE_EXTRA_CA_CERTS"] } },
        },
        {},
      ),
    ).toBe(true);
  });
});
