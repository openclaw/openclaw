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

  it("parses JSON-stringified risk metadata values", () => {
    expect(
      decodeMetaFrontmatter({
        name: "meta-demo",
        description: "Demo meta skill",
        kind: "meta",
        triggers: '["demo"]',
        composition: '{"steps":[{"id":"draft","kind":"llm_chat","prompt":"Draft"}]}',
        risk_metadata: '{"level":"medium","requiresApproval":true}',
      }).risk_metadata,
    ).toEqual({
      level: "medium",
      requiresApproval: true,
    });
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

  it("preserves plan-level risk metadata", () => {
    const parsed = parseMetaPlan({
      ...validRaw,
      risk_metadata: {
        level: "medium",
        requiresApproval: true,
        notes: ["writes pending proposals only"],
      },
    });

    expect(parsed.riskMetadata).toEqual({
      level: "medium",
      requiresApproval: true,
      notes: ["writes pending proposals only"],
    });
  });

  it("parses bounded failover failure policies", () => {
    const parsed = parseMetaPlan({
      ...validRaw,
      composition: {
        steps: [
          {
            id: "publish",
            kind: "tool_call",
            tool: "primary_publish",
            args: {
              body: "{{input.body}}",
            },
            on_failure: {
              kind: "failover",
              max_attempts: 1,
              attempts: [
                {
                  tool: "backup_publish",
                  args: {
                    body: "{{input.body}}",
                    mode: "backup",
                  },
                },
                {
                  tool: "last_chance_publish",
                },
              ],
            },
          },
        ],
      },
      final_text_mode: "step:publish",
    });

    expect(parsed.steps[0].onFailure).toEqual({
      kind: "failover",
      maxAttempts: 1,
      attempts: [
        {
          toolName: "backup_publish",
          args: {
            body: "{{input.body}}",
            mode: "backup",
          },
        },
        {
          toolName: "last_chance_publish",
        },
      ],
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

  it("parses step when expressions for conditional DAG branches", () => {
    const parsed = parseMetaPlan({
      ...validRaw,
      composition: {
        steps: [
          {
            id: "classify",
            kind: "llm_classify",
            choices: ["approve", "reject"],
            prompt: "Classify",
          },
          {
            id: "approve",
            kind: "tool_call",
            depends_on: ["classify"],
            tool: "publish",
            when: { path: "classify.choice", equals: "approve" },
          },
          {
            id: "reject",
            kind: "tool_call",
            depends_on: ["classify"],
            tool: "archive",
            when: "{{classify.choice}}",
          },
        ],
      },
      final_text_mode: "auto",
    });

    expect(parsed.steps[1]).toMatchObject({
      id: "approve",
      when: { kind: "equals", path: "classify.choice", value: "approve" },
    });
    expect(parsed.steps[2]).toMatchObject({
      id: "reject",
      when: { kind: "truthy", path: "classify.choice" },
    });
  });

  it("parses route cases for downstream branch selection", () => {
    const parsed = parseMetaPlan({
      ...validRaw,
      composition: {
        steps: [
          {
            id: "classify",
            kind: "llm_classify",
            choices: ["publish", "archive"],
            prompt: "Classify",
            route: {
              path: "choice",
              cases: {
                publish: ["publish"],
                archive: ["archive"],
              },
              default: ["review"],
            },
          },
          {
            id: "publish",
            kind: "tool_call",
            depends_on: ["classify"],
            tool: "publish",
          },
          {
            id: "archive",
            kind: "tool_call",
            depends_on: ["classify"],
            tool: "archive",
          },
          {
            id: "review",
            kind: "user_input",
            depends_on: ["classify"],
            schema: { type: "object" },
          },
        ],
      },
      final_text_mode: "auto",
    });

    expect(parsed.steps[0]).toMatchObject({
      id: "classify",
      route: {
        path: "choice",
        cases: {
          publish: ["publish"],
          archive: ["archive"],
        },
        default: ["review"],
      },
    });
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

  it("rejects missing required fields for step kinds", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "classify", kind: "llm_classify" }],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step classify llm_classify requires non-empty choices");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "publish", kind: "tool_call" }],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step publish tool_call requires tool");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "delegate", kind: "skill_exec" }],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step delegate skill_exec requires skill");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "spawn", kind: "agent", args: { message: "Handle this" } }],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step spawn agent requires args.sessionKey");
  });

  it("rejects invalid risk metadata and unbounded failover policies", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        risk_metadata: "medium",
      }),
    ).toThrow("risk metadata must be an object");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "draft",
              kind: "llm_chat",
              on_failure: {
                kind: "failover",
                attempts: [],
              },
            },
          ],
        },
      }),
    ).toThrow("on_failure.attempts must be a non-empty array");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "draft",
              kind: "llm_chat",
              on_failure: {
                kind: "failover",
                max_attempts: 2,
                attempts: [{ prompt: "Backup" }],
              },
            },
          ],
        },
      }),
    ).toThrow("on_failure.max_attempts cannot exceed on_failure.attempts length");
  });

  it("rejects invalid when expressions", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [{ id: "draft", kind: "llm_chat", when: "draft text" }],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step draft when must be a dotted output path");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "draft",
              kind: "llm_chat",
              when: { path: "input.topic", equals: "a", in: ["a"] },
            },
          ],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step draft when must declare exactly one operator");
  });

  it("rejects invalid route cases", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "classify",
              kind: "llm_classify",
              choices: ["publish"],
              route: { path: "choice value", cases: { publish: ["publish"] } },
            },
            {
              id: "publish",
              kind: "tool_call",
              depends_on: ["classify"],
              tool: "publish",
            },
          ],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step classify route.path must be a dotted output path");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "classify",
              kind: "llm_classify",
              choices: ["publish"],
              route: { path: "choice", cases: { publish: [] } },
            },
            {
              id: "publish",
              kind: "tool_call",
              depends_on: ["classify"],
              tool: "publish",
            },
          ],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step classify route.cases.publish must be a non-empty array of strings");
  });

  it("rejects route targets that are unknown or not downstream", () => {
    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "classify",
              kind: "llm_classify",
              choices: ["publish"],
              route: { path: "choice", cases: { publish: ["missing"] } },
            },
          ],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step classify route references unknown step missing");

    expect(() =>
      parseMetaPlan({
        ...validRaw,
        composition: {
          steps: [
            {
              id: "classify",
              kind: "llm_classify",
              choices: ["publish"],
              route: { path: "choice", cases: { publish: ["publish"] } },
            },
            {
              id: "publish",
              kind: "tool_call",
              tool: "publish",
            },
          ],
        },
        final_text_mode: "auto",
      }),
    ).toThrow("step classify route target publish must depend on classify");
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
