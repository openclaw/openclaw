import { describe, expect, it } from "vitest";
import {
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  normalizeMessagePresentation,
  type MessagePresentation,
  type MessagePresentationButton,
  type MessagePresentationButtonsBlock,
  type MessagePresentationOption,
  type MessagePresentationSelectBlock,
} from "../../../interactive/payload.js";
import {
  adaptMessagePresentationForChannel,
  applyPresentationActionLimits,
  presentationPageSize,
  reduceInteractiveReply,
} from "../../../plugin-sdk/interactive-runtime.js";

type PresentationCapabilities = Parameters<
  typeof adaptMessagePresentationForChannel
>[0]["capabilities"];

type Blocks = MessagePresentation["blocks"];
type Limits = NonNullable<PresentationCapabilities>["limits"];

function adaptBlocks(blocks: Blocks, capabilities: PresentationCapabilities) {
  return adaptMessagePresentationForChannel({ presentation: { blocks }, capabilities });
}

function adaptLimitedBlocks(blocks: Blocks, limits: Limits) {
  return adaptBlocks(blocks, { limits });
}

describe("reduceInteractiveReply", () => {
  it("walks authored blocks in order", () => {
    const order = reduceInteractiveReply(
      {
        blocks: [
          { type: "text", text: "first" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
          { type: "select", options: [{ label: "Alpha", value: "alpha" }] },
        ],
      },
      [] as string[],
      (state, block) => {
        state.push(block.type);
        return state;
      },
    );

    expect(order).toEqual(["text", "buttons", "select"]);
  });

  it("returns the initial state when interactive payload is missing", () => {
    expect(reduceInteractiveReply(undefined, 3, (value) => value + 1)).toBe(3);
  });
});

function expectLimitedBlocks(blocks: Blocks, limits: Limits, expected: Blocks) {
  expect(adaptLimitedBlocks(blocks, limits).blocks).toEqual(expected);
}

function buttonBlock(...buttons: MessagePresentationButton[]): MessagePresentationButtonsBlock {
  return { type: "buttons", buttons: structuredClone(buttons) };
}

function selectBlock(
  options: MessagePresentationOption[],
  placeholder?: string,
): MessagePresentationSelectBlock {
  return {
    type: "select",
    options: structuredClone(options),
    ...(placeholder === undefined ? {} : { placeholder }),
  };
}

function contextBlock(text: string): { type: "context"; text: string } {
  return { type: "context", text };
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

const textEncodings = [
  { encoding: "characters" as const, length: (text: string) => Array.from(text).length },
  { encoding: "utf8-bytes" as const, length: (text: string) => Buffer.byteLength(text, "utf8") },
  { encoding: "utf16-units" as const, length: (text: string) => text.length },
] as const;

function fallbackFragments(
  blocks: Blocks,
  type: "text" | "context",
  maxLength: number,
  length = textEncodings[0].length,
) {
  return blocks.map((block) => {
    expect(block.type).toBe(type);
    const text = block.type === "text" || block.type === "context" ? block.text : "";
    expect(length(text)).toBeLessThanOrEqual(maxLength);
    return text;
  });
}

const canary = { label: "Canary", value: "canary" };
const keep = { label: "Keep", value: "keep" };
const high = { label: "High", value: "high", priority: 10 };
const docs = { label: "Docs", url: "https://docs.example.test" };
const wait: MessagePresentationButton = { label: "Wait", value: "wait", disabled: true };
const one = { label: "One", value: "one" };
const two = { label: "Two", value: "two" };
const three = { label: "Three", value: "three" };
const four = { label: "Four", value: "four" };
const five = { label: "Five", value: "five" };
const six = { label: "Six", value: "six" };
describe("presentation capability limits", () => {
  it("drops model-picker actions until a channel integration opts in", () => {
    const buttons = applyPresentationActionLimits(
      [
        {
          label: "Model",
          action: {
            type: "model-picker",
            version: 1,
            snapshotToken: "snapshot_1",
            intent: "choose-model",
            providerToken: "provider_1",
            modelToken: "model_1",
          },
        },
      ],
      { buttons: true },
    );

    expect(buttons).toEqual([]);
  });

  it("keeps highest-priority buttons inside action capacity", () => {
    const buttons = applyPresentationActionLimits(
      [
        { label: "Low", value: "low", priority: -1 },
        { label: "Default", value: "default" },
        { ...high },
        { label: "Next", value: "next", priority: 5 },
      ],
      { limits: { actions: { maxActions: 2, maxLabelLength: 4, supportsStyles: false } } },
    );

    expect(buttons).toEqual([high, { label: "Next", value: "next", priority: 5 }]);
  });

  it("keeps authored button order when nothing is dropped", () => {
    const buttons = applyPresentationActionLimits(
      [
        { label: "First", value: "first", priority: 1 },
        { label: "Second", value: "second", priority: 100 },
        { label: "Third", value: "third" },
      ],
      {
        limits: {
          actions: {
            maxActionsPerRow: 5,
          },
        },
      },
    );

    expect(buttons).toEqual([
      { label: "First", value: "first", priority: 1 },
      { label: "Second", value: "second", priority: 100 },
      { label: "Third", value: "third" },
    ]);
  });

  it("applies callback byte limits to typed command actions", () => {
    const buttons = applyPresentationActionLimits(
      [
        {
          label: "Keep",
          action: { type: "command", command: "/codex plugins menu" },
        },
        {
          label: "Drop",
          action: { type: "command", command: `/codex plugins enable ${"x".repeat(20)}` },
        },
      ],
      {
        limits: {
          actions: {
            maxValueBytes: 24,
          },
        },
      },
    );

    expect(buttons).toEqual([
      {
        label: "Keep",
        action: { type: "command", command: "/codex plugins menu" },
      },
    ]);
  });

  it("keeps typed button actions when only the legacy fallback exceeds value limits", () => {
    const buttons = applyPresentationActionLimits(
      [
        {
          label: "Keep",
          value: "legacy-value-that-is-too-long",
          action: { type: "command", command: "/short" },
        },
      ],
      {
        limits: {
          actions: {
            maxValueBytes: 8,
          },
        },
      },
    );

    expect(buttons).toEqual([
      {
        label: "Keep",
        action: { type: "command", command: "/short" },
      },
    ]);
  });

  it("keeps approval and link actions out of generic callback byte limits", () => {
    const buttons = applyPresentationActionLimits(
      [
        {
          label: "Approve",
          action: {
            type: "approval",
            approvalId: "approval/with/a/long/stable/id",
            approvalKind: "exec",
            decision: "allow-once",
          },
        },
        {
          label: "Review",
          action: { type: "url", url: "https://example.test/approve/a-long-id" },
        },
        {
          label: "Open app",
          action: { type: "web-app", url: "https://example.test/app/a-long-id" },
        },
        {
          label: "Open widget",
          action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
        },
      ],
      {
        limits: {
          actions: {
            maxValueBytes: 4,
          },
        },
      },
    );

    expect(buttons).toEqual([
      {
        label: "Approve",
        action: {
          type: "approval",
          approvalId: "approval/with/a/long/stable/id",
          approvalKind: "exec",
          decision: "allow-once",
        },
      },
      {
        label: "Review",
        action: { type: "url", url: "https://example.test/approve/a-long-id" },
      },
      {
        label: "Open app",
        action: { type: "web-app", url: "https://example.test/app/a-long-id" },
      },
      {
        label: "Open widget",
        action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
      },
    ]);
  });

  it.each<[string, Blocks, Limits, Blocks]>([
    [
      "preserves legacy fields without letting them override canonical action semantics",
      [
        buttonBlock({
          label: "Approve",
          action: {
            type: "approval",
            approvalId: "approval:1",
            approvalKind: "plugin",
            decision: "deny",
          },
          value: "legacy-shadow",
          url: "https://ignored.example.test",
        }),
      ],
      { actions: { maxValueBytes: 4 } },
      [
        buttonBlock({
          label: "Approve",
          action: {
            type: "approval",
            approvalId: "approval:1",
            approvalKind: "plugin",
            decision: "deny",
          },
          url: "https://ignored.example.test",
        }),
      ],
    ],
    [
      "keeps typed select actions when only the legacy fallback exceeds value limits",
      [
        selectBlock([
          {
            label: "Keep",
            value: "legacy-value-that-is-too-long",
            action: { type: "callback", value: "short" },
          },
        ]),
      ],
      { selects: { maxValueBytes: 8 } },
      [selectBlock([{ label: "Keep", action: { type: "callback", value: "short" } }])],
    ],
    [
      "keeps visible fallback labels when controls exceed channel value limits",
      [
        buttonBlock(
          { label: "Approve deployment", value: "approve-prod" },
          { label: "Rollback deployment", value: "rollback-prod" },
        ),
        selectBlock(
          [
            { label: "Canary cluster", value: "canary-target" },
            { label: "Production cluster", value: "production-target" },
          ],
          "Environment",
        ),
      ],
      {
        actions: { maxValueBytes: 4, maxLabelLength: 8 },
        selects: { maxValueBytes: 4, maxLabelLength: 7 },
      },
      [
        contextBlock("Actions:\n- Approve deployment\n- Rollback deployment"),
        contextBlock("Environment:\n- Canary cluster\n- Production cluster"),
      ],
    ],
    [
      "keeps dropped command buttons actionable without exposing private callbacks",
      [
        buttonBlock(
          keep,
          { label: "Deploy", action: { type: "command", command: "/deploy production" } },
          {
            label: "Approval",
            action: {
              type: "approval",
              approvalId: "approval:private-transport-token",
              approvalKind: "exec",
              decision: "allow-once",
            },
          },
          { label: "Opaque", action: { type: "callback", value: "private-callback-token" } },
        ),
      ],
      { actions: { maxActions: 1 } },
      [
        buttonBlock(keep),
        contextBlock("Actions:\n- Deploy: `/deploy production`\n- Approval\n- Opaque"),
      ],
    ],
    [
      "keeps fallback labels for invalid buttons in mixed button blocks",
      [
        buttonBlock(
          { label: "Approve", value: "ok" },
          { label: "Audit trail", value: "x".repeat(20) },
          { label: "Docs", value: "x".repeat(20), url: "https://docs.example.test" },
          {
            label: "Retry",
            action: { type: "callback", value: "x".repeat(20) },
            url: "https://ignored.example.test",
          },
        ),
      ],
      { actions: { maxValueBytes: 4 } },
      [
        buttonBlock({ label: "Approve", value: "ok" }, docs),
        contextBlock("Actions:\n- Audit trail\n- Retry"),
      ],
    ],
    [
      "keeps disabled link fallback non-actionable",
      [
        buttonBlock({
          label: "Unavailable",
          action: { type: "url", url: "https://private.example.test" },
          disabled: true,
        }),
      ],
      { actions: {} },
      [contextBlock("Actions:\n- Unavailable")],
    ],
    [
      "keeps fallback labels for invalid or overflowed select options",
      [
        selectBlock(
          [
            canary,
            { label: "Production", value: "prod" },
            { label: "Long callback", value: "x".repeat(20) },
          ],
          "Target",
        ),
      ],
      { selects: { maxOptions: 1, maxValueBytes: 8 } },
      [selectBlock([canary], "Target"), contextBlock("Target:\n- Production\n- Long callback")],
    ],
    [
      "applies button priority across the shared action budget",
      [buttonBlock({ label: "Low", value: "low" }), buttonBlock(high)],
      { actions: { maxActions: 1 } },
      [contextBlock("Actions:\n- Low"), buttonBlock(high)],
    ],
    [
      "keeps link targets when overflowed buttons become fallback text",
      [buttonBlock(one), buttonBlock(docs)],
      { actions: { maxActions: 1, maxLabelLength: 4 } },
      [buttonBlock(one), contextBlock("Actions:\n- Docs: https://docs.example.test")],
    ],
    [
      "preserves callback button values when actions do not declare a value limit",
      [buttonBlock({ label: "Approve", value: "x".repeat(180) })],
      { actions: { maxActions: 5, maxActionsPerRow: 5 } },
      [buttonBlock({ label: "Approve", value: "x".repeat(180) })],
    ],
    [
      "preserves authored button precedence when only action rows are bounded",
      [
        buttonBlock({ label: "First", value: "first" }),
        selectBlock([{ label: "Later", value: "later" }], "Target"),
      ],
      { actions: { maxRows: 1 } },
      [buttonBlock({ label: "First", value: "first" }), contextBlock("Target:\n- Later")],
    ],
    [
      "splits button blocks by per-row limits even when rows are unlimited",
      [buttonBlock(one, two, three, four, five, six)],
      { actions: { maxActions: 20, maxActionsPerRow: 5 } },
      [buttonBlock(one, two, three, four, five), buttonBlock(six)],
    ],
    [
      "counts selects against the shared action capacity",
      [selectBlock([canary], "Target"), buttonBlock(one, two, three)],
      { actions: { maxActions: 3, maxActionsPerRow: 5, maxRows: 5 } },
      [selectBlock([canary], "Target"), buttonBlock(one, two), contextBlock("Actions:\n- Three")],
    ],
  ])("%s", (_name, blocks, limits, expected) => {
    expectLimitedBlocks(blocks, limits, expected);
  });

  it("adapts button and select blocks without touching text blocks", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        title: "Deploy",
        blocks: [
          textBlock("Ready"),
          buttonBlock(
            { label: "Approve deployment", value: "approve", style: "success" },
            { label: "Reject", value: "x".repeat(12), priority: 10 },
          ),
          selectBlock(
            [
              { label: "Canary cluster", value: "canary" },
              { label: "Production cluster", value: "production" },
            ],
            "Environment target",
          ),
        ],
      },
      capabilities: {
        limits: {
          actions: {
            maxActions: 2,
            maxLabelLength: 7,
            maxValueBytes: 8,
            supportsStyles: false,
            supportsDisabled: false,
          },
          selects: { maxOptions: 1, maxLabelLength: 6, maxValueBytes: 20 },
        },
      },
    });

    expect(presentation).toEqual({
      title: "Deploy",
      blocks: [
        textBlock("Ready"),
        buttonBlock({ label: "Approve", value: "approve" }),
        contextBlock("Actions:\n- Reject"),
        selectBlock([canary], "Enviro"),
        contextBlock("Environment target:\n- Production cluster"),
      ],
    });
  });

  it("keeps unavailable typed select commands actionable without exposing callback values", () => {
    const presentation = adaptBlocks(
      [
        selectBlock(
          [
            { label: "Canary", action: { type: "command", command: "/deploy canary" } },
            { label: "Production", action: { type: "command", command: "/deploy production" } },
            { label: "Opaque", action: { type: "callback", value: "private-callback-token" } },
          ],
          "Environment",
        ),
      ],
      { selects: false },
    );

    expect(presentation.blocks).toEqual([
      contextBlock(
        "Environment:\n- Canary: `/deploy canary`\n- Production: `/deploy production`\n- Opaque",
      ),
    ]);
  });

  it("degrades disabled buttons unless the channel supports disabled controls", () => {
    const unsupported = adaptLimitedBlocks([buttonBlock(wait)], { actions: {} });
    const supported = adaptLimitedBlocks([buttonBlock(wait)], {
      actions: { supportsDisabled: true },
    });

    expect(unsupported.blocks).toEqual([contextBlock("Actions:\n- Wait")]);
    expect(supported.blocks).toEqual([buttonBlock(wait)]);
  });

  it("degrades unsupported controls before channel rendering", () => {
    const presentation = adaptBlocks(
      [
        buttonBlock({ label: "Approve", value: "approve" }),
        selectBlock([canary], "Target"),
        { type: "divider" },
        contextBlock("Muted details"),
      ],
      {
        buttons: false,
        selects: false,
        context: false,
        divider: false,
        limits: { actions: { maxLabelLength: 4 }, selects: { maxLabelLength: 6 } },
      },
    );

    expect(presentation.blocks).toEqual([
      textBlock("Actions:\n- Approve"),
      textBlock("Target:\n- Canary"),
      textBlock("Muted details"),
    ]);
  });

  it("splits unsupported button fallbacks without losing action labels", () => {
    const labels = ["Approve production", "Rollback release", "Show audit trail"];
    const maxLength = 24;
    const presentation = adaptBlocks(
      [
        {
          type: "buttons",
          buttons: labels.map((label, index) => ({ label, value: `action-${index}` })),
        },
      ],
      {
        buttons: false,
        context: false,
        limits: { actions: { maxLabelLength: 4 }, text: { maxLength, encoding: "characters" } },
      },
    );

    const fallback = fallbackFragments(presentation.blocks, "text", maxLength);
    expect(fallback.length).toBeGreaterThan(1);
    expect(fallback.join("")).toBe(`Actions:\n${labels.map((label) => `- ${label}`).join("\n")}`);
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      `Actions:\n${labels.map((label) => `- ${label}`).join("\n")}`,
    );
  });

  it("splits overflow select fallbacks without losing unavailable options", () => {
    const maxLength = 18;
    const presentation = adaptLimitedBlocks(
      [
        selectBlock(
          [
            canary,
            { label: "Production cluster", value: "production" },
            { label: "Rollback environment", value: "rollback" },
          ],
          "Deployment target",
        ),
      ],
      {
        selects: { maxOptions: 1, maxLabelLength: 4 },
        text: { maxLength, encoding: "characters" },
      },
    );

    expect(presentation.blocks[0]).toMatchObject(selectBlock([{ label: "Cana", value: "canary" }]));
    const fallback = fallbackFragments(presentation.blocks.slice(1), "context", maxLength);
    expect(fallback.length).toBeGreaterThan(1);
    expect(fallback.join("")).toBe(
      "Deployment target:\n- Production cluster\n- Rollback environment",
    );
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      "Depl:\n- Cana\n\nDeployment target:\n- Production cluster\n- Rollback environment",
    );
  });

  it("splits titles, text, context, and generated fallback without losing content", () => {
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        title: "abcdef",
        blocks: [
          textBlock("hello world"),
          contextBlock("abcdef"),
          buttonBlock({ label: "Deploy", value: "toolong" }),
        ],
      },
      capabilities: {
        limits: { actions: { maxValueBytes: 2 }, text: { maxLength: 5, encoding: "characters" } },
      },
    });

    expect(presentation).toEqual({
      title: "abcde",
      blocks: [
        ...["f", "hello", " worl", "d"].map(textBlock),
        ...["abcde", "f", "Actio", "ns:\n", "- Dep", "loy"].map(contextBlock),
      ],
    });
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      "abcdef\n\nhello world\n\nabcdef\n\nActions:\n- Deploy",
    );
  });

  it.each(textEncodings)(
    "preserves authored Unicode content under $encoding limits",
    ({ encoding, length }) => {
      const text = `${"😀".repeat(64)} split \n${"e\u0301 ".repeat(24)}last`;
      const original = {
        title: text,
        blocks: [textBlock(text), contextBlock(text)],
      };
      const capabilities = { context: false, limits: { text: { maxLength: 6, encoding } } };
      const presentation = adaptMessagePresentationForChannel({
        presentation: original,
        capabilities,
      });
      expect(length(presentation.title ?? "")).toBeLessThanOrEqual(6);
      for (const block of presentation.blocks) {
        expect(block.type).toBe("text");
        if (block.type === "text") {
          expect(length(block.text)).toBeLessThanOrEqual(6);
          expect(Buffer.from(block.text, "utf8").toString("utf8")).toBe(block.text);
        }
      }
      expect(renderMessagePresentationFallbackText({ presentation })).toBe(
        renderMessagePresentationFallbackText({ presentation: original }),
      );
      expect(
        renderMessagePresentationFallbackText({
          presentation: normalizeMessagePresentation(
            adaptMessagePresentationForChannel({ presentation, capabilities }),
          ),
        }),
      ).toBe(renderMessagePresentationFallbackText({ presentation: original }));
      expect(adaptMessagePresentationForChannel({ presentation: original })).toEqual(original);
    },
  );

  it.each([
    {
      sample: "astral labels",
      labels: ["😀😀😀", "🚀🚀🚀", "👍👍👍"] as const,
      prefixes: ["😀😀", "🚀🚀", "👍👍"] as const,
    },
    {
      sample: "long labels with isolated surrogates",
      labels: ["A\uD800B".repeat(24), "\uDC00AB".repeat(24), "😀\uD800Z".repeat(24)] as const,
      prefixes: ["A\uD800", "\uDC00A", "😀\uD800"] as const,
    },
  ])("preserves code-point prefixes for $sample", ({ labels, prefixes }) => {
    expectLimitedBlocks(
      [
        buttonBlock({ label: labels[0], value: "ok" }),
        selectBlock([{ label: labels[2], value: "yes" }], labels[1]),
      ],
      { actions: { maxLabelLength: 2 }, selects: { maxLabelLength: 2 } },
      [
        buttonBlock({ label: prefixes[0], value: "ok" }),
        selectBlock([{ label: prefixes[2], value: "yes" }], prefixes[1]),
      ],
    );
  });

  it("keeps local row limits when the raw button count fits the global capacity", () => {
    const presentation = adaptLimitedBlocks(
      [
        buttonBlock(one),
        buttonBlock(two),
        buttonBlock(
          { label: "Three", value: "three", priority: 10 },
          { label: "Four", value: "four", priority: 10 },
        ),
      ],
      { actions: { maxActionsPerRow: 2, maxRows: 2 } },
    );

    expect(presentation).toStrictEqual({
      blocks: [buttonBlock(one), buttonBlock(two), contextBlock("Actions:\n- Three\n- Four")],
    });
  });

  it("adapts repeated button occurrences independently and rereads changed input", () => {
    const button = { label: "😀 more", value: "first", style: "primary" as const };
    const block = { type: "buttons" as const, buttons: [button, button] };
    const presentation: MessagePresentation = { blocks: [block, block] };
    const actions = {
      maxActions: 4,
      maxActionsPerRow: 2,
      maxRows: 2,
      maxLabelLength: 1,
      supportsStyles: false,
    };
    const first = adaptMessagePresentationForChannel({
      presentation,
      capabilities: { limits: { actions } },
    });
    const expectedFirst = {
      blocks: Array.from({ length: 2 }, () => ({
        type: "buttons",
        buttons: [
          { label: "😀", value: "first" },
          { label: "😀", value: "first" },
        ],
      })),
    };

    expect(first).toStrictEqual(expectedFirst);
    const copies = first.blocks.flatMap((entry) => (entry.type === "buttons" ? entry.buttons : []));
    expect(new Set(copies).size).toBe(4);
    expect(copies).not.toContain(button);
    expect(button).toStrictEqual({ label: "😀 more", value: "first", style: "primary" });

    button.label = "Updated";
    button.value = "second";
    actions.maxLabelLength = 2;
    const second = adaptMessagePresentationForChannel({
      presentation,
      capabilities: { limits: { actions } },
    });

    expect(second).toStrictEqual({
      blocks: Array.from({ length: 2 }, () => ({
        type: "buttons",
        buttons: [
          { label: "Up", value: "second" },
          { label: "Up", value: "second" },
        ],
      })),
    });
    expect(first).toStrictEqual(expectedFirst);
  });
  it.each([false, true])(
    "reserves a select row with rejected leading options: %s",
    (hasRejected) => {
      expectLimitedBlocks(
        [
          buttonBlock(one, two, three),
          selectBlock(
            [...(hasRejected ? [{ label: "Rejected", value: "too-long" }] : []), four],
            "Extra",
          ),
        ],
        {
          actions: { maxActionsPerRow: 2, maxRows: 2 },
          selects: { maxOptions: 1, maxValueBytes: 4 },
        },
        [
          buttonBlock(one, two),
          contextBlock("Actions:\n- Three"),
          selectBlock([four], "Extra"),
          ...(hasRejected ? [contextBlock("Extra:\n- Rejected")] : []),
        ],
      );
    },
  );

  it("resolves page size from available action capacity", () => {
    expect(
      presentationPageSize({ limits: { actions: { maxActionsPerRow: 5, maxRows: 2 } } }, 1, 20),
    ).toBe(9);
  });

  it("keeps charts only for channels that explicitly advertise native support", () => {
    const chart = {
      type: "chart" as const,
      chartType: "bar" as const,
      title: "Quarterly revenue",
      categories: ["Q1", "Q2"],
      series: [{ name: "Revenue", values: [120, 145] }],
    };

    expect(adaptBlocks([chart], { charts: true }).blocks).toEqual([chart]);
    expect(adaptBlocks([chart], { context: true }).blocks).toEqual([
      contextBlock("Quarterly revenue (bar chart)\n- Revenue: Q1: 120; Q2: 145"),
    ]);
    expect(adaptBlocks([chart], { context: false }).blocks[0]?.type).toBe("text");
  });

  it("splits chart fallback without losing the final series or category", () => {
    const categories = Array.from(
      { length: 20 },
      (_, index) => `Category-${String(index).padStart(2, "0")}`,
    );
    const series = Array.from({ length: 12 }, (_, seriesIndex) => ({
      name: `Series-${String(seriesIndex).padStart(2, "0")}`,
      values: categories.map((_category, categoryIndex) => seriesIndex * 100 + categoryIndex),
    }));
    const chart = {
      type: "chart" as const,
      chartType: "line" as const,
      title: "Quarterly revenue",
      categories,
      series,
    };
    const maxLength = 500;
    const presentation = adaptBlocks([chart], {
      context: true,
      limits: { text: { maxLength, encoding: "characters" } },
    });
    const fallbackBlocks = fallbackFragments(presentation.blocks, "context", maxLength);

    expect(fallbackBlocks.length).toBeGreaterThan(1);
    const fallbackText = fallbackBlocks.join("");
    expect(fallbackText).toBe(renderMessagePresentationChartFallbackText(chart));
    expect(fallbackText).toContain("Category-19: 1119");
  });

  it("keeps tables only for channels that explicitly advertise native support", () => {
    const table = {
      type: "table" as const,
      caption: "Pipeline report",
      headers: ["Account", "Stage", "ARR"],
      rows: [
        ["Acme", "Won", 125000],
        ["Globex", "Review", 82000],
      ],
      rowHeaderColumnIndex: 0,
    };

    expect(adaptBlocks([table], { tables: true }).blocks).toEqual([table]);
    expect(adaptBlocks([table], { context: true }).blocks).toEqual([
      contextBlock(
        [
          "Pipeline report (table)",
          "- Account: Acme; Stage: Won; ARR: 125000",
          "- Account: Globex; Stage: Review; ARR: 82000",
        ].join("\n"),
      ),
    ]);
    expect(adaptBlocks([table], { context: false }).blocks[0]?.type).toBe("text");
  });

  it.each(textEncodings)(
    "splits table fallback by line without losing rows for $encoding limits",
    ({ encoding, length }) => {
      const rows = Array.from({ length: 12 }, (_, index) => [
        `Account-${String(index).padStart(2, "0")}`,
        `Stage-${index}`,
      ]);
      const maxLength = 64;
      const presentation = adaptBlocks(
        [{ type: "table", caption: "Pipeline report", headers: ["Account", "Stage"], rows }],
        { context: true, limits: { text: { maxLength, encoding } } },
      );
      const fallbackBlocks = fallbackFragments(presentation.blocks, "context", maxLength, length);

      expect(fallbackBlocks.length).toBeGreaterThan(1);
      expect(fallbackBlocks.join("")).toBe(
        [
          "Pipeline report (table)",
          ...rows.map(([account, stage]) => `- Account: ${account}; Stage: ${stage}`),
        ].join("\n"),
      );
    },
  );

  it("hard-splits an oversized table row without breaking UTF-16 surrogate pairs", () => {
    const value = "😀".repeat(20);
    const maxLength = 10;
    const presentation = adaptBlocks(
      [{ type: "table", caption: "R", headers: ["Value"], rows: [[value]] }],
      { context: false, limits: { text: { maxLength, encoding: "utf16-units" } } },
    );
    const fallbackBlocks = fallbackFragments(
      presentation.blocks,
      "text",
      maxLength,
      (text) => text.length,
    );

    expect(
      fallbackBlocks.every((text) => {
        const first = text.charCodeAt(0);
        const last = text.charCodeAt(text.length - 1);
        return !(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff);
      }),
    ).toBe(true);
    expect(fallbackBlocks[0]).toBe("R (table)\n");
    expect(fallbackBlocks.slice(1).join("")).toBe(`- Value: ${value}`);
  });
});
