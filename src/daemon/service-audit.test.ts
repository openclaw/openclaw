import { describe, expect, it } from "vitest";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "./service-audit.js";

describe("auditGatewayServiceConfig", () => {
  it("flags bun runtime", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/opt/homebrew/bin/bun", "gateway"],
        environment: { PATH: "/usr/bin:/bin" },
      },
    });
    expect(audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(
      true,
    );
  });

  it("flags version-managed node paths", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/Users/test/.nvm/versions/node/v22.0.0/bin/node", "gateway"],
        environment: {
          PATH: "/usr/bin:/bin:/Users/test/.nvm/versions/node/v22.0.0/bin",
        },
      },
    });
    expect(
      audit.issues.some(
        (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      ),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(true);
  });
});
