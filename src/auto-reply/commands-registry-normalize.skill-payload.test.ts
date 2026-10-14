import { describe, expect, it } from "vitest";
import {
  expandExplicitSkillReferences,
  resolveSkillCommandInvocation,
} from "../skills/discovery/chat-command-invocation.js";
import { normalizeCommandBody } from "./commands-registry-normalize.js";

describe("skill payload normalization", () => {
  const skill = { name: "demo_skill", skillName: "demo-skill", description: "Demo" };
  const skillCommands = [skill];

  it("preserves interior skill whitespace through invocation and request expansion", () => {
    const payloads = ["def f():\n    return 1", "first\n\n    paragraph", "first\n\tsecond"];
    const heads = [
      ["/skill demo_skill ", "/skill demo_skill "],
      ["/demo_skill ", "/demo_skill "],
      ["/SKILL@openclaw: demo_skill ", "/skill demo_skill "],
      ["/demo_skill@openclaw: ", "/demo_skill "],
      ["/skill\t \tdemo_skill\t \t", "/skill demo_skill\t \t"],
      ["/demo_skill\t \t", "/demo_skill\t \t"],
    ] as const;
    for (const [head, normalizedHead] of heads) {
      for (const payload of payloads) {
        const normalized = normalizeCommandBody(`${head}${payload}`, { botUsername: "openclaw" });
        expect(normalized).toBe(`${normalizedHead}${payload}`);
        expect(
          resolveSkillCommandInvocation({ commandBodyNormalized: normalized, skillCommands })?.args,
        ).toBe(payload);
        expect(expandExplicitSkillReferences({ text: normalized, skillCommands }).body).toBe(
          [
            "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
            "- demo-skill",
            "",
            "User request:",
            `${normalizedHead}${payload}`,
          ].join("\n"),
        );
        expect(
          expandExplicitSkillReferences({
            text: normalized,
            skillCommands: [{ ...skill, promptTemplate: "Review:\n$ARGUMENTS" }],
          }).body,
        ).toBe(`Review:\n${payload}`);
      }
    }
  });

  it("keeps leading skill separators normalized before payload content starts", () => {
    const cases = [
      ["/skill\n\n    demo_skill first", "/skill\ndemo_skill first"],
      ["/skill demo_skill\n\n    first", "/skill demo_skill\nfirst"],
      ["/demo_skill\n\n    first", "/demo_skill\nfirst"],
      ["/skill@openclaw: demo_skill\n\n    first", "/skill demo_skill\nfirst"],
    ] as const;
    for (const [raw, expected] of cases) {
      const normalized = normalizeCommandBody(raw, { botUsername: "openclaw" });
      expect(normalized).toBe(expected);
      expect(
        resolveSkillCommandInvocation({ commandBodyNormalized: normalized, skillCommands })?.args,
      ).toBe("first");
    }
  });

  it("keeps non-skill multiline policies and outer payload trimming unchanged", () => {
    const cases = [
      ["/side first\n\n    second", "/btw first"],
      ["/id\n\n    ignored", "/whoami"],
      ["/reset soft\n\n    re-read\tpersona files", "/reset soft re-read persona files"],
      ["/learn first\n\n    second", "/learn first\nsecond"],
      ["/goal set first\n\n    second", "/goal set first\n\n    second"],
      ["/steer first\n\n    second", "/steer first\n\n    second"],
      ["  /skill demo_skill first\n    second\n  ", "/skill demo_skill first\n    second"],
    ] as const;
    for (const [raw, expected] of cases) {
      expect(normalizeCommandBody(raw)).toBe(expected);
    }
  });
});
