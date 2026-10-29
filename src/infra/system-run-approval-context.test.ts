import { describe, expect, test } from "vitest";
import {
  parsePreparedSystemRunPayload as parsePayload,
  resolveSystemRunApprovalRequestContext as requestContext,
  resolveSystemRunApprovalRuntimeContext as runtimeContext,
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
      requestContext({
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
    const context = requestContext({
      host: "gateway",
      command: preparedPlan.commandText,
      commandArgv: preparedPlan.argv,
      ...identity,
      systemRunPlan: { argv: ["ignored"], commandText: "ignored" },
    });

    expect(context).toEqual({
      plan: null,
      commandArgv: preparedPlan.argv,
      commandText: preparedPlan.commandText,
      commandPreview: null,
      ...identity,
    });
  });

  test("preserves whitespace in cwd from a node plan", () => {
    const context = requestContext({
      host: "node",
      command: "echo hi",
      cwd: "/fallback",
      systemRunPlan: {
        argv: ["echo", "hi"],
        cwd: "/srv/data ",
        commandText: "echo hi",
      },
    });
    expect(context).toMatchObject({ cwd: "/srv/data ", plan: { cwd: "/srv/data " } });
  });
});

describe("parsePreparedSystemRunPayload", () => {
  test.each(["mutableFileOperand", "policySnapshot"])(
    "does not reconstruct plans rejected for invalid %s",
    (field) => {
      expect(
        parsePayload({
          plan: { ...preparedPlan, [field]: null },
          commandText: "jq --version",
        }),
      ).toBeNull();
    },
  );

  test("parses prepared exec policy metadata", () => {
    const execPolicy = { security: "allowlist", ask: "always" };
    expect(parsePayload({ plan: preparedPlan, execPolicy })).toEqual({
      plan: { ...preparedPlan, commandPreview: null, agentId: null, sessionKey: null },
      execPolicy,
    });
  });

  test.each([
    { plan: { argv: [] }, commandText: "jq --version" },
    { plan: { argv: ["jq", "--version"] } },
  ])("rejects incomplete legacy payload %j", (payload) => {
    expect(parsePayload(payload)).toBeNull();
  });
});

describe("resolveSystemRunApprovalRuntimeContext", () => {
  test("uses normalized plan runtime metadata when available", () => {
    const plan = Object.freeze({ ...jqPlan, commandPreview: "jq --version" });
    expect(runtimeContext({ plan })).toEqual({ ok: true, plan, ...jqPlan });
  });

  test.each([
    [["bash", "-lc", "jq --version"], 'bash -lc "jq --version"', "/tmp"],
    [["echo", "hi"], "echo hi", "/srv/data "],
  ] as const)("validates fallback %j (%j) and preserves cwd %j", (args, commandText, cwd) => {
    const argv = Object.freeze([...args]);
    expect(
      runtimeContext({
        command: argv,
        rawCommand: commandText,
        ...identity,
        cwd,
      }),
    ).toEqual({ ok: true, plan: null, argv, commandText, ...identity, cwd });
  });

  test("falls back to params.sessionKey when the plan has no sessionKey", () => {
    expect(
      resolveSystemRunApprovalRuntimeContext({
        plan: {
          argv: ["jq", "--version"],
          cwd: "/tmp",
          commandText: "jq --version",
          agentId: "main",
          sessionKey: null,
        },
        sessionKey: "agent:main:dashboard:abc123",
      }),
    ).toEqual({
      ok: true,
      plan: {
        argv: ["jq", "--version"],
        cwd: "/tmp",
        commandText: "jq --version",
        commandPreview: null,
        agentId: "main",
        sessionKey: "agent:main:dashboard:abc123",
      },
      argv: ["jq", "--version"],
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:dashboard:abc123",
      commandText: "jq --version",
    });
  });

  test("returns request validation errors from command fallback", () => {
    expect(runtimeContext({ rawCommand: "jq --version" })).toEqual({
      ok: false,
      message: "rawCommand requires params.command",
      details: { code: "MISSING_COMMAND" },
    });
  });
});
