import { describe, expect, test } from "vitest";
import {
  parsePreparedSystemRunPayload,
  resolveSystemRunApprovalRequestContext,
  resolveSystemRunApprovalRuntimeContext,
} from "./system-run-approval-context.js";

const identity = { cwd: "/tmp", agentId: "main", sessionKey: "agent:main:main" };
// Shared input/expectation fixtures must not hide mutations by the normalizer.
const preparedPlan = Object.freeze({
  argv: Object.freeze(["jq", "--version"]),
  commandText: "jq --version",
  cwd: "/tmp",
});
const jqPlan = Object.freeze({ ...preparedPlan, ...identity });

describe("resolveSystemRunApprovalRequestContext", () => {
  test("derives preview from fallback command for older node plans", () => {
    const argv = Object.freeze(["./env", "sh", "-c", "jq --version"]);
    const commandText = './env sh -c "jq --version"';
    expect(
      resolveSystemRunApprovalRequestContext({
        host: "node",
        command: "jq --version",
        cwd: "/fallback",
        agentId: "fallback",
        sessionKey: "agent:fallback:main",
        systemRunPlan: { argv, rawCommand: commandText, ...identity },
      }),
    ).toEqual({
      plan: { argv, commandText, commandPreview: "jq --version", ...identity },
      commandText,
      commandPreview: "jq --version",
      commandArgv: argv,
      ...identity,
    });
  });

  test("falls back to explicit request params for non-node hosts", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "gateway",
      command: "jq --version",
      commandArgv: ["jq", "--version"],
      ...identity,
      systemRunPlan: {
        argv: ["ignored"],
        commandText: "ignored",
      },
    });

    expect(context).toEqual({
      plan: null,
      commandArgv: ["jq", "--version"],
      commandText: "jq --version",
      commandPreview: null,
      ...identity,
    });
  });

  test("preserves whitespace in cwd from a node plan", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "node",
      command: "echo hi",
      cwd: "/fallback",
      systemRunPlan: {
        argv: ["echo", "hi"],
        cwd: "/srv/data ",
        commandText: "echo hi",
      },
    });
    expect(context.cwd).toBe("/srv/data ");
    expect(context.plan?.cwd).toBe("/srv/data ");
  });
});

describe("parsePreparedSystemRunPayload", () => {
  test.each(["mutableFileOperand", "policySnapshot"])(
    "does not reconstruct plans rejected for invalid %s",
    (field) => {
      expect(
        parsePreparedSystemRunPayload({
          plan: { argv: ["jq", "--version"], commandText: "jq --version", [field]: null },
          commandText: "jq --version",
        }),
      ).toBeNull();
    },
  );

  test("parses prepared exec policy metadata", () => {
    expect(
      parsePreparedSystemRunPayload({
        plan: preparedPlan,
        execPolicy: { security: "allowlist", ask: "always" },
      }),
    ).toEqual({
      plan: { ...preparedPlan, commandPreview: null, agentId: null, sessionKey: null },
      execPolicy: { security: "allowlist", ask: "always" },
    });
  });

  test.each([
    { plan: { argv: [] }, commandText: "jq --version" },
    { plan: { argv: ["jq", "--version"] } },
  ])("rejects incomplete legacy payload %j", (payload) => {
    expect(parsePreparedSystemRunPayload(payload)).toBeNull();
  });
});

describe("resolveSystemRunApprovalRuntimeContext", () => {
  test("uses normalized plan runtime metadata when available", () => {
    const plan = Object.freeze({ ...jqPlan, commandPreview: "jq --version" });
    expect(resolveSystemRunApprovalRuntimeContext({ plan })).toEqual({ ok: true, plan, ...jqPlan });
  });

  test.each([
    [["bash", "-lc", "jq --version"], 'bash -lc "jq --version"', "/tmp"],
    [["echo", "hi"], "echo hi", "/srv/data "],
  ] as const)("validates fallback %j (%j) and preserves cwd %j", (args, commandText, cwd) => {
    const argv = Object.freeze([...args]);
    expect(
      resolveSystemRunApprovalRuntimeContext({
        command: argv,
        rawCommand: commandText,
        ...identity,
        cwd,
      }),
    ).toEqual({ ok: true, plan: null, argv, commandText, ...identity, cwd });
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
