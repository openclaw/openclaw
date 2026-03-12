import { describe, expect, test } from "vitest";
import { resolveSystemRunApprovalRequestContext } from "./system-run-approval-context.js";

describe("resolveSystemRunApprovalRequestContext", () => {
  test("uses full approval text and separate preview for node system.run plans", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "node",
      command: "jq --version",
      systemRunPlan: {
        argv: ["./env", "sh", "-c", "jq --version"],
        cwd: "/tmp",
        commandText: './env sh -c "jq --version"',
        commandPreview: "jq --version",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(context.commandText).toBe('./env sh -c "jq --version"');
    expect(context.commandPreview).toBe("jq --version");
    expect(context.commandArgv).toEqual(["./env", "sh", "-c", "jq --version"]);
  });

  test("derives preview from fallback command for older node plans", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "node",
      command: "jq --version",
      systemRunPlan: {
        argv: ["./env", "sh", "-c", "jq --version"],
        cwd: "/tmp",
        rawCommand: './env sh -c "jq --version"',
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(context.commandText).toBe('./env sh -c "jq --version"');
    expect(context.commandPreview).toBe("jq --version");
  });
});
