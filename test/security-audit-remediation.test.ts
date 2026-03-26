import { describe, expect, it } from "vitest";
import {
  collectSecurityAuditRemediationViolations,
  findSecurityAuditRemediationViolations,
  main,
} from "../scripts/check-security-audit-remediation.mjs";

function createCapturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
        },
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}

describe("security audit remediation guard", () => {
  it("flags warn or critical findings without remediation", () => {
    const violations = findSecurityAuditRemediationViolations(
      'findings.push({ severity: "warn", title: "Bad", detail: "oops" });\n',
      "/Users/frank/Documents/Projects/openclaw-main/src/security/audit.ts",
    );
    expect(violations).toEqual([
      expect.objectContaining({
        severity: "warn",
        title: "Bad",
      }),
    ]);
  });

  it("repo security audit findings satisfy the guard", async () => {
    expect(await collectSecurityAuditRemediationViolations()).toEqual([]);
  });

  it("script json output matches the collector", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});
