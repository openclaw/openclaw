import { describe, expect, it } from "vitest";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBinding,
  matchSystemRunApprovalEnvHash,
  missingSystemRunApprovalBinding,
  normalizeSystemRunApprovalPlan,
} from "./system-run-approval-binding.js";

describe("normalizeSystemRunApprovalPlan", () => {
  it("accepts commandText and normalized mutable file operands", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        mutableFileOperand: {
          argvIndex: 2,
          path: " /tmp/payload.txt ",
          sha256: " abc123 ",
        },
      }),
    ).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      commandText: 'bash -lc "echo hi"',
      commandPreview: "echo hi",
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:main",
      mutableFileOperand: {
        argvIndex: 2,
        path: "/tmp/payload.txt",
        sha256: "abc123",
      },
    });
  });

  it("falls back to rawCommand and rejects invalid file operands", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["bash", "-lc", "echo hi"],
        rawCommand: 'bash -lc "echo hi"',
      }),
    ).toEqual({
      argv: ["bash", "-lc", "echo hi"],
      commandText: 'bash -lc "echo hi"',
      commandPreview: null,
      cwd: null,
      agentId: null,
      sessionKey: null,
      mutableFileOperand: undefined,
    });

    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        mutableFileOperand: {
          argvIndex: -1,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      }),
    ).toBeNull();
  });
});

describe("buildSystemRunApprovalEnvBinding", () => {
  it("normalizes, filters, and sorts env keys before hashing", () => {
    const normalized = buildSystemRunApprovalEnvBinding({
      z_key: "b",
      " bad key ": "ignored",
      alpha: "a",
      EMPTY: 1,
    });
    const reordered = buildSystemRunApprovalEnvBinding({
      alpha: "a",
      z_key: "b",
    });

    expect(normalized).toEqual({
      envHash: reordered.envHash,
      envKeys: ["alpha", "z_key"],
    });
    expect(normalized.envHash).toBeTypeOf("string");
    expect(normalized.envHash).toHaveLength(64);
  });

  it("returns a null hash when no usable env entries remain", () => {
    expect(buildSystemRunApprovalEnvBinding(null)).toEqual({
      envHash: null,
      envKeys: [],
    });
    expect(
      buildSystemRunApprovalEnvBinding({
        bad: 1,
      }),
    ).toEqual({
      envHash: null,
      envKeys: [],
    });
  });
});

describe("buildSystemRunApprovalBinding", () => {
  it("normalizes argv and metadata into a binding", () => {
    const envBinding = buildSystemRunApprovalEnvBinding({
      beta: "2",
      alpha: "1",
    });

    expect(
      buildSystemRunApprovalBinding({
        argv: ["bash", "-lc", 12],
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        env: {
          beta: "2",
          alpha: "1",
        },
      }),
    ).toEqual({
      binding: {
        argv: ["bash", "-lc", "12"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        envHash: envBinding.envHash,
      },
      envKeys: ["alpha", "beta"],
    });
  });
});

describe("matchSystemRunApprovalEnvHash", () => {
  it("handles matching, missing, and mismatched env bindings", () => {
    expect(
      matchSystemRunApprovalEnvHash({
        expectedEnvHash: null,
        actualEnvHash: null,
        actualEnvKeys: [],
      }),
    ).toEqual({ ok: true });

    expect(
      matchSystemRunApprovalEnvHash({
        expectedEnvHash: null,
        actualEnvHash: "abc",
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({
      ok: false,
      code: "APPROVAL_ENV_BINDING_MISSING",
      message: "approval id missing env binding for requested env overrides",
      details: { envKeys: ["ALPHA"] },
    });

    expect(
      matchSystemRunApprovalEnvHash({
        expectedEnvHash: "abc",
        actualEnvHash: "def",
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({
      ok: false,
      code: "APPROVAL_ENV_MISMATCH",
      message: "approval id env binding mismatch",
      details: {
        envKeys: ["ALPHA"],
        expectedEnvHash: "abc",
        actualEnvHash: "def",
      },
    });
  });
});

describe("matchSystemRunApprovalBinding", () => {
  const expected = {
    argv: ["bash", "-lc", "echo hi"],
    cwd: "/tmp",
    agentId: "main",
    sessionKey: "agent:main:main",
    envHash: "abc",
  };

  it("accepts exact matches", () => {
    expect(
      matchSystemRunApprovalBinding({
        expected,
        actual: { ...expected },
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    {
      name: "argv mismatch",
      actual: { ...expected, argv: ["bash", "-lc", "echo bye"] },
    },
    {
      name: "cwd mismatch",
      actual: { ...expected, cwd: "/var/tmp" },
    },
    {
      name: "agent mismatch",
      actual: { ...expected, agentId: "other" },
    },
    {
      name: "session mismatch",
      actual: { ...expected, sessionKey: "agent:main:other" },
    },
  ])("rejects $name", ({ actual }) => {
    expect(
      matchSystemRunApprovalBinding({
        expected,
        actual,
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: undefined,
    });
  });
});

describe("missingSystemRunApprovalBinding", () => {
  it("reports env keys with request mismatches", () => {
    expect(missingSystemRunApprovalBinding({ actualEnvKeys: ["ALPHA", "BETA"] })).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: {
        envKeys: ["ALPHA", "BETA"],
      },
    });
  });
});
