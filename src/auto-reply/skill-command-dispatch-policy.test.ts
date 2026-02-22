import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_COMMAND_DISPATCH_MAX_ARG_LENGTH,
  matchesSkillCommandDispatchToolPattern,
  prepareSkillCommandToolDispatch,
} from "./skill-command-dispatch-policy.js";

describe("matchesSkillCommandDispatchToolPattern", () => {
  it("matches gateway wildcard against dot and slash tool naming", () => {
    expect(matchesSkillCommandDispatchToolPattern("gateway", "gateway/*")).toBe(true);
    expect(matchesSkillCommandDispatchToolPattern("gateway.restart", "gateway/*")).toBe(true);
    expect(matchesSkillCommandDispatchToolPattern("gateway/restart", "gateway/*")).toBe(true);
    expect(matchesSkillCommandDispatchToolPattern("nodes.run", "gateway/*")).toBe(false);
  });
});

describe("prepareSkillCommandToolDispatch", () => {
  it("blocks dangerous tools by default", () => {
    const res = prepareSkillCommandToolDispatch({
      cfg: {},
      toolName: "exec",
      rawArgs: "echo hello",
      commandName: "danger",
      skillName: "danger-skill",
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.message).toContain("blocked");
  });

  it("allows dangerous tools when explicitly allowlisted", () => {
    const res = prepareSkillCommandToolDispatch({
      cfg: { skills: { commandDispatch: { allowTools: ["exec"] } } },
      toolName: "exec",
      rawArgs: "echo hello",
      commandName: "danger",
      skillName: "danger-skill",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.toolParams).toEqual({
      command: "echo hello",
      commandName: "danger",
      skillName: "danger-skill",
    });
  });

  it("enforces max arg length", () => {
    const res = prepareSkillCommandToolDispatch({
      cfg: {
        skills: {
          commandDispatch: {
            allowTools: ["exec"],
            maxArgLength: 3,
          },
        },
      },
      toolName: "exec",
      rawArgs: "echo",
      commandName: "danger",
      skillName: "danger-skill",
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.message).toContain("maxArgLength");
  });

  it("defaults max arg length when unset", () => {
    const oversized = "x".repeat(DEFAULT_SKILL_COMMAND_DISPATCH_MAX_ARG_LENGTH + 1);
    const res = prepareSkillCommandToolDispatch({
      cfg: {
        skills: {
          commandDispatch: {
            allowTools: ["exec"],
          },
        },
      },
      toolName: "exec",
      rawArgs: oversized,
      commandName: "danger",
      skillName: "danger-skill",
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.message).toContain("maxArgLength");
  });

  it("requires JSON object when configured", () => {
    const res = prepareSkillCommandToolDispatch({
      cfg: {
        skills: {
          commandDispatch: {
            allowTools: ["exec"],
            requireStructuredArgsTools: ["exec"],
          },
        },
      },
      toolName: "exec",
      rawArgs: '{"command":"echo hi","timeout":2000}',
      commandName: "danger",
      skillName: "danger-skill",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.toolParams).toEqual({
      command: "echo hi",
      timeout: 2000,
      commandName: "danger",
      skillName: "danger-skill",
    });
  });

  it("rejects non-JSON structured args when required", () => {
    const res = prepareSkillCommandToolDispatch({
      cfg: {
        skills: {
          commandDispatch: {
            allowTools: ["exec"],
            requireStructuredArgsTools: ["exec"],
          },
        },
      },
      toolName: "exec",
      rawArgs: "echo hi",
      commandName: "danger",
      skillName: "danger-skill",
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.message).toContain("JSON object");
  });
});
