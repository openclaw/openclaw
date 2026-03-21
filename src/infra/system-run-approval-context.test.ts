import { describe, expect, test } from "vitest";
import {
  parsePreparedSystemRunPayload,
  resolveSystemRunApprovalRequestContext,
  resolveSystemRunApprovalRuntimeContext,
} from "./system-run-approval-context.js";

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

  test("falls back to explicit request params for non-node hosts", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "gateway",
      command: "jq --version",
      commandArgv: ["jq", "--version"],
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:main",
      systemRunPlan: {
        argv: ["ignored"],
        commandText: "ignored",
      },
    });

    expect(context.plan).toBeNull();
    expect(context.commandArgv).toEqual(["jq", "--version"]);
    expect(context.commandText).toBe("jq --version");
    expect(context.commandPreview).toBeNull();
    expect(context.cwd).toBe("/tmp");
    expect(context.agentId).toBe("main");
    expect(context.sessionKey).toBe("agent:main:main");
  });
});

describe("parsePreparedSystemRunPayload", () => {
  test("parses legacy prepared payloads via top-level fallback command text", () => {
    expect(
      parsePreparedSystemRunPayload({
        plan: {
          argv: ["bash", "-lc", "jq --version"],
          cwd: "/tmp",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
        commandText: 'bash -lc "jq --version"',
      }),
    ).toEqual({
      plan: {
        argv: ["bash", "-lc", "jq --version"],
        cwd: "/tmp",
        commandText: 'bash -lc "jq --version"',
        commandPreview: null,
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });
  });

  test("rejects legacy payloads missing argv or command text", () => {
    expect(parsePreparedSystemRunPayload({ plan: { argv: [] }, commandText: "jq --version" })).toBe(
      null,
    );
    expect(
      parsePreparedSystemRunPayload({
        plan: { argv: ["jq", "--version"] },
      }),
    ).toBeNull();
  });
});

describe("resolveSystemRunApprovalRuntimeContext", () => {
  test("uses normalized plan runtime metadata when available", () => {
    expect(
      resolveSystemRunApprovalRuntimeContext({
        plan: {
          argv: ["jq", "--version"],
          cwd: "/tmp",
          commandText: "jq --version",
          commandPreview: "jq --version",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      }),
    ).toEqual({
      ok: true,
      plan: {
        argv: ["jq", "--version"],
        cwd: "/tmp",
        commandText: "jq --version",
        commandPreview: "jq --version",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      argv: ["jq", "--version"],
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:main",
      commandText: "jq --version",
    });
  });

  test("falls back to command/rawCommand validation without a plan", () => {
    expect(
      resolveSystemRunApprovalRuntimeContext({
        command: ["bash", "-lc", "jq --version"],
        rawCommand: 'bash -lc "jq --version"',
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({
      ok: true,
      plan: null,
      argv: ["bash", "-lc", "jq --version"],
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:main",
      commandText: 'bash -lc "jq --version"',
    });
  });

  test("returns request validation errors from command fallback", () => {
    expect(
      resolveSystemRunApprovalRuntimeContext({
        rawCommand: "jq --version",
      }),
    ).toEqual({
      ok: false,
      message: "rawCommand requires params.command",
      details: { code: "MISSING_COMMAND" },
    });
  });
});
