import { describe, expect, it } from "vitest";
import { decodeMetaFrontmatter } from "./frontmatter.js";
import { parseMetaPlan } from "./parser.js";

const validRaw = {
  name: "meta-demo",
  description: "Demo meta skill",
  kind: "meta",
  triggers: ["demo", "demo followup"],
  composition: {
    steps: [
      { id: "draft", kind: "llm_chat", prompt: "Draft {{input}}" },
      {
        id: "final",
        kind: "llm_chat",
        depends_on: ["draft"],
        prompt: "Finalize {{draft.text}}",
      },
    ],
  },
  final_text_mode: "step:final",
};

describe("decodeMetaFrontmatter", () => {
  it("parses JSON-stringified structured frontmatter fields", () => {
    expect(
      decodeMetaFrontmatter({
        name: "meta-demo",
        description: "Demo meta skill",
        kind: "meta",
        triggers: '["demo"]',
        composition: '{"steps":[{"id":"draft","kind":"llm_chat","prompt":"Draft"}]}',
        final_text_mode: "step:draft",
      }),
    ).toEqual({
      name: "meta-demo",
      description: "Demo meta skill",
      kind: "meta",
      triggers: ["demo"],
      composition: {
        steps: [{ id: "draft", kind: "llm_chat", prompt: "Draft" }],
      },
      final_text_mode: "step:draft",
    });
  });

  it("parses JSON-stringified scalar final_text_mode values and keeps ordinary strings", () => {
    expect(
      decodeMetaFrontmatter({
        name: "meta-demo",
        description: "Demo meta skill",
        kind: "meta",
        triggers: '["demo"]',
        composition: '{"steps":[{"id":"draft","kind":"llm_chat","prompt":"Draft"}]}',
        final_text_mode: '"raw"',
      }).final_text_mode,
    ).toBe("raw");

    expect(
      decodeMetaFrontmatter({
        name: "meta-demo",
        description: "Demo meta skill",
        kind: "meta",
        triggers: '["demo"]',
        composition: '{"steps":[{"id":"draft","kind":"llm_chat","prompt":"Draft"}]}',
        final_text_mode: '"step:draft"',
      }).final_text_mode,
    ).toBe("step:draft");

    expect(
      decodeMetaFrontmatter({
        name: "meta-demo",
        description: "Demo meta skill",
        kind: "meta",
        triggers: '["demo"]',
        composition: '{"steps":[{"id":"draft","kind":"llm_chat","prompt":"Draft"}]}',
        final_text_mode: "step:draft",
      }).final_text_mode,
    ).toBe("step:draft");
  });
});

describe("parseMetaPlan", () => {
  it("parses a valid meta plan", () => {
    const parsed = parseMetaPlan(validRaw);

    expect(parsed).toMatchObject({
      name: "meta-demo",
      description: "Demo meta skill",
      triggers: [{ pattern: "demo" }, { pattern: "demo followup" }],
      finalTextMode: { kind: "step", stepId: "final" },
    });
    expect(parsed.steps.map((step) => step.id)).toEqual(["draft", "final"]);
    expect(parsed.steps[0]).toMatchObject({
      id: "draft",
      kind: "llm_chat",
      dependsOn: [],
      prompt: "Draft {{input}}",
      onFailure: { kind: "fail" },
    });
    expect(parsed.steps[1]).toMatchObject({
      id: "final",
      kind: "llm_chat",
      dependsOn: ["draft"],
      prompt: "Finalize {{draft.text}}",
      onFailure: { kind: "fail" },
    });
  });

  it("returns steps in deterministic topological order", () => {
    const parsed = parseMetaPlan({
      ...validRaw,
      composition: {
        steps: [
          {
            id: "final",
            kind: "llm_chat",
            depends_on: ["draft"],
            prompt: "Finalize {{draft.text}}",
          },
          { id: "draft", kind: "llm_chat", prompt: "Draft {{input}}" },
          { id: "publish", kind: "tool_call", depends_on: ["final"], tool: "notify" },
        ],
      },
      final_text_mode: "step:publish",
    });

    expect(parsed.steps.map((step) => step.id)).toEqual(["draft", "final", "publish"]);
  });

  it("parses final_text_mode auto", () => {
    expect(
      parseMetaPlan({
        ...validRaw,
        final_text_mode: "auto",
      }).finalTextMode,
    ).toEqual({ kind: "auto" });
  });

  it("parses final_text_mode raw", () => {
    expect(
      parseMetaPlan({
        ...validRaw,
        final_text_mode: "raw",
      }).finalTextMode,
    ).toEqual({ kind: "raw" });
  });

  it("rejects non-meta skills", () => {
    expect(() => parseMetaPlan({ ...validRaw, kind: "ordinary" })).toThrow(
      "Meta skill kind must be meta",
    );
  });

  it("rejects missing triggers", () => {
    const { triggers: _triggers, ...rawWithoutTriggers } = validRaw;
    expect(() => parseMetaPlan(rawWithoutTriggers)).toThrow("triggers must be an array");
  });

  it("rejects unsupported step kinds", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "bad", kind: "shell_script", prompt: "nope" }],
        },
      }),
    ).toThrow("Unsupported meta step kind: shell_script");
  });

  it("rejects present optional string fields that are blank", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "draft", kind: "tool_call", tool: "   " }],
        },
      }),
    ).toThrow("step draft tool must be a non-empty string");
  });

  it("rejects present optional object fields that are not objects", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "draft", kind: "user_input", schema: "not-an-object" }],
        },
      }),
    ).toThrow("step draft schema must be an object");
  });

  it("rejects duplicate step ids", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            { id: "same", kind: "llm_chat", prompt: "one" },
            { id: "same", kind: "llm_chat", prompt: "two" },
          ],
        },
      }),
    ).toThrow("Duplicate meta step id: same");
  });

  it("rejects dependencies that do not exist", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "final",
              kind: "llm_chat",
              depends_on: ["missing"],
              prompt: "Finalize",
            },
          ],
        },
      }),
    ).toThrow("depends on unknown step missing");
  });

  it("rejects dependency cycles", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            { id: "a", kind: "llm_chat", depends_on: ["b"], prompt: "A" },
            { id: "b", kind: "llm_chat", depends_on: ["a"], prompt: "B" },
          ],
        },
      }),
    ).toThrow("Meta plan contains a dependency cycle");
  });

  it("rejects final_text_mode step references that do not exist", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        final_text_mode: "step:missing",
      }),
    ).toThrow("final_text_mode references unknown step missing");
  });
});
