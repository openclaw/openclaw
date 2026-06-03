import { describe, expect, it } from "vitest";
import { renderMetaTemplate, renderMetaTemplateArgs } from "./template.js";

describe("renderMetaTemplate", () => {
  it("renders nested paths and blanks missing or null values", () => {
    expect(
      renderMetaTemplate(
        [
          "Topic: {{input.topic}}",
          "Details: {{draft.payload}}",
          "Missing: <{{draft.missing}}>",
          "Null: <{{draft.nil}}>",
          "Primitive: {{draft.score}}",
        ].join("\n"),
        {
          input: { topic: "Meta migration" },
          draft: {
            payload: { tags: ["meta", "task-3"] },
            nil: null,
            score: 2,
          },
        },
      ),
    ).toBe(
      [
        "Topic: Meta migration",
        'Details: {"tags":["meta","task-3"]}',
        "Missing: <>",
        "Null: <>",
        "Primitive: 2",
      ].join("\n"),
    );
  });
});

describe("renderMetaTemplateArgs", () => {
  it("renders templated strings recursively through arrays and objects", () => {
    expect(
      renderMetaTemplateArgs(
        {
          tool: "notify",
          summary: "{{input.summary}}",
          nested: {
            draft: "{{draft.text}}",
            score: "{{draft.score}}",
            items: ["{{draft.tags}}", "{{draft.text}}", 7, true, null],
          },
        },
        {
          input: { summary: "Ship Task 3" },
          draft: {
            text: "Runner ready",
            score: 3,
            tags: ["meta", "runner"],
          },
        },
      ),
    ).toEqual({
      tool: "notify",
      summary: "Ship Task 3",
      nested: {
        draft: "Runner ready",
        score: "3",
        items: ['["meta","runner"]', "Runner ready", 7, true, null],
      },
    });
  });

  it("rejects cyclic args structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => renderMetaTemplateArgs(cyclic, {})).toThrow("Meta template args contain a cycle");
  });

  it("rejects overly deep args structures", () => {
    let deep: Record<string, unknown> = { value: "{{input.summary}}" };
    for (let index = 0; index < 21; index += 1) {
      deep = { nested: deep };
    }

    expect(() =>
      renderMetaTemplateArgs(deep, {
        input: { summary: "too deep" },
      }),
    ).toThrow("Meta template args exceed max depth");
  });
});
