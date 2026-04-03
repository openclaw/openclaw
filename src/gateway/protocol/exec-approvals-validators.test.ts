import { describe, expect, it } from "vitest";
import { validateExecApprovalsNodeSetParams, validateExecApprovalsSetParams } from "./index.js";

describe("exec approvals protocol validators", () => {
  const file = {
    version: 1 as const,
    agents: {
      main: {
        allowlist: [
          {
            pattern: "=command:613b5a60181648fd",
            source: "allow-always" as const,
            commandText: 'powershell -NoProfile -Command "Write-Output hi"',
            lastUsedCommand: 'powershell -NoProfile -Command "Write-Output hi"',
          },
        ],
      },
    },
  };

  it("accepts gateway exec approvals payloads with durable allow-always metadata", () => {
    expect(validateExecApprovalsSetParams({ file, baseHash: "hash-1" })).toBe(true);
  });

  it("accepts node exec approvals payloads with durable allow-always metadata", () => {
    expect(
      validateExecApprovalsNodeSetParams({
        nodeId: "node-1",
        file,
        baseHash: "hash-1",
      }),
    ).toBe(true);
  });
});
