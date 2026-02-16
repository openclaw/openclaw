import { describe, expect, it } from "vitest";
import { auditGatewayServiceConfig, SERVICE_AUDIT_CODES } from "./service-audit.js";
import { buildMinimalServicePath } from "./service-env.js";

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

  it("accepts Linux minimal PATH with user directories", async () => {
    const env = { HOME: "/home/testuser", PNPM_HOME: "/opt/pnpm" };
    const minimalPath = buildMinimalServicePath({ platform: "linux", env });
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: minimalPath },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(false);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("flags gateway token mismatch when service token is stale", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "linux",
      expectedGatewayToken: "new-token",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          OPENCLAW_GATEWAY_TOKEN: "old-token",
        },
      },
    });
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayTokenMismatch),
    ).toBe(true);
  });

  it("does not flag gateway token mismatch when service token matches config token", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "linux",
      expectedGatewayToken: "new-token",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          OPENCLAW_GATEWAY_TOKEN: "new-token",
        },
      },
    });
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayTokenMismatch),
    ).toBe(false);
  });
});
