import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLaunchAgentPlistPath } from "./launchd.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import {
  auditGatewayServiceConfig,
  checkTokenDrift,
  SERVICE_AUDIT_CODES,
} from "./service-audit.js";
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

describe("checkTokenDrift", () => {
  it("returns null when both tokens are undefined", () => {
    const result = checkTokenDrift({ serviceToken: undefined, configToken: undefined });
    expect(result).toBeNull();
  });

  it("returns null when both tokens are empty strings", () => {
    const result = checkTokenDrift({ serviceToken: "", configToken: "" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match", () => {
    const result = checkTokenDrift({ serviceToken: "same-token", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("detects drift when config has token but service has different token", () => {
    const result = checkTokenDrift({ serviceToken: "old-token", configToken: "new-token" });
    expect(result).not.toBeNull();
    expect(result?.code).toBe(SERVICE_AUDIT_CODES.gatewayTokenDrift);
    expect(result?.message).toContain("differs from service token");
  });

  it("detects drift when config has token but service has no token", () => {
    const result = checkTokenDrift({ serviceToken: undefined, configToken: "new-token" });
    expect(result).not.toBeNull();
    expect(result?.code).toBe(SERVICE_AUDIT_CODES.gatewayTokenDrift);
  });

  it("returns null when service has token but config does not", () => {
    // This is not really drift - service will work, just config is incomplete
    const result = checkTokenDrift({ serviceToken: "service-token", configToken: undefined });
    expect(result).toBeNull();
  });
});

describe("auditGatewayServiceConfig launchd policy", () => {
  async function withTempHome(testFn: (env: Record<string, string>) => Promise<void>) {
    const tmpHomeRaw = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-"));
    const tmpHome = tmpHomeRaw.replaceAll("\\", "/");
    const env = { HOME: tmpHome, OPENCLAW_PROFILE: "default" };
    try {
      await testFn(env);
    } finally {
      await fs.rm(tmpHomeRaw, { recursive: true, force: true });
    }
  }

  it("flags legacy KeepAlive=true plist and missing ThrottleInterval", async () => {
    await withTempHome(async (env) => {
      const plistPath = resolveLaunchAgentPlistPath(env);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n  <dict>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n  </dict>\n</plist>\n`,
        "utf8",
      );

      const audit = await auditGatewayServiceConfig({
        env,
        platform: "darwin",
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: "/usr/bin:/bin" },
        },
      });

      expect(audit.issues.some((i) => i.code === SERVICE_AUDIT_CODES.launchdKeepAlive)).toBe(true);
      expect(
        audit.issues.some((i) => i.code === SERVICE_AUDIT_CODES.launchdThrottleInterval),
      ).toBe(true);
    });
  });

  it("accepts KeepAlive.SuccessfulExit and ThrottleInterval=5", async () => {
    await withTempHome(async (env) => {
      const plistPath = resolveLaunchAgentPlistPath(env);
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(
        plistPath,
        buildLaunchAgentPlist({
          label: "ai.openclaw.gateway",
          programArguments: ["/usr/bin/node", "gateway"],
          stdoutPath: "/tmp/openclaw.out.log",
          stderrPath: "/tmp/openclaw.err.log",
        }),
        "utf8",
      );

      const audit = await auditGatewayServiceConfig({
        env,
        platform: "darwin",
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: "/usr/bin:/bin" },
        },
      });

      expect(audit.issues.some((i) => i.code === SERVICE_AUDIT_CODES.launchdKeepAlive)).toBe(false);
      expect(
        audit.issues.some((i) => i.code === SERVICE_AUDIT_CODES.launchdThrottleInterval),
      ).toBe(false);
    });
  });
});
