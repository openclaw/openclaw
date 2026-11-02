import { describe, expect, it } from "vitest";
import type {
  MessagePresentationAction,
  MessagePresentationBlock,
  ModelPickerAction,
} from "./payload.js";
import {
  hasReplyChannelData,
  hasReplyContent,
  hasReplyPayloadContent,
  normalizeInteractiveReply,
  normalizeMessagePresentation,
  presentationToInteractiveControlsReply,
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationControlValue,
  resolveMessagePresentationOptionAction,
  resolveInteractiveTextFallback,
} from "./payload.js";

function buttonPresentation<const T extends unknown[]>(...buttons: T) {
  return { blocks: [{ type: "buttons" as const, buttons }] };
}

describe("hasReplyChannelData", () => {
  it.each([
    { value: undefined, expected: false },
    { value: {}, expected: false },
    { value: [], expected: false },
  ] as const)("rejects empty or non-object channel data: %j", ({ value, expected }) => {
    expect(hasReplyChannelData(value)).toBe(expected);
  });
});

describe("hasReplyContent", () => {
  it("treats whitespace-only text and empty structured payloads as empty", () => {
    expect(
      hasReplyContent({
        text: "   ",
        mediaUrls: ["", "   "],
        interactive: { blocks: [] },
        hasChannelData: false,
      }),
    ).toBe(false);
  });

  it("accepts shared interactive blocks", () => {
    expect(
      hasReplyContent({ interactive: buttonPresentation({ label: "Retry", value: "retry" }) }),
    ).toBe(true);
  });
});

describe("hasReplyPayloadContent", () => {
  it("treats portable locations as content", () => {
    expect(
      hasReplyPayloadContent({
        location: { latitude: 1, longitude: 2 },
      }),
    ).toBe(true);
  });

  it("trims text and falls back to channel data by default", () => {
    expect(
      hasReplyPayloadContent({
        text: "   ",
        channelData: { slack: { blocks: [] } },
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "explicit channel-data overrides",
      payload: {
        text: "   ",
        channelData: {},
      },
      options: {
        hasChannelData: true,
      },
    },
    {
      name: "extra content",
      payload: {
        text: "   ",
      },
      options: {
        extraContent: true,
      },
    },
  ] as const)("accepts $name", ({ payload, options }) => {
    expect(hasReplyPayloadContent(payload, options)).toBe(true);
  });
});

describe("interactive payload helpers", () => {
  it("normalizes interactive replies and resolves text fallbacks", () => {
    const interactive = normalizeInteractiveReply({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        { type: "text", text: "Second" },
      ],
    });

    expect(interactive).toEqual({
      blocks: [
        { type: "text", text: "First" },
        { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        { type: "text", text: "Second" },
      ],
    });
    expect(resolveInteractiveTextFallback({ interactive })).toBe("First\n\nSecond");
  });

  it("preserves URL-only presentation buttons for native link renderers and fallback text", () => {
    const presentation = buttonPresentation({ label: "Docs", url: "https://example.com/docs" });

    expect(presentationToInteractiveReply(presentation)).toEqual(
      buttonPresentation({ label: "Docs", url: "https://example.com/docs" }),
    );
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      "- Docs: https://example.com/docs",
    );
  });

  it("preserves web app presentation buttons for channel-native renderers", () => {
    const presentation = buttonPresentation({
      label: "Launch",
      web_app: { url: "https://example.com/app" },
    });
    const normalized = normalizeMessagePresentation(presentation);

    expect(normalized).toEqual(
      buttonPresentation({ label: "Launch", webApp: { url: "https://example.com/app" } }),
    );
    expect(presentationToInteractiveReply(normalized!)).toEqual(
      buttonPresentation({ label: "Launch", webApp: { url: "https://example.com/app" } }),
    );
    expect(renderMessagePresentationFallbackText({ presentation: normalized })).toBe(
      "- Launch: https://example.com/app",
    );
  });

  it("normalizes typed presentation actions and bridges them to legacy values", () => {
    const presentation = buttonPresentation(
      {
        label: "Plugins",
        action: { type: "command", command: "/codex plugins menu" },
      },
      {
        label: "Approve",
        action: { type: "callback", value: "/approve req allow-once" },
      },
      {
        label: "Allow once",
        action: {
          type: "approval",
          approvalId: "approval/😀",
          approvalKind: "exec",
          decision: "allow-once",
        },
      },
      {
        label: "Review",
        action: { type: "url", url: "https://example.com/approve/id" },
      },
      {
        label: "Open app",
        action: { type: "web-app", url: "https://example.com/app" },
      },
    );
    const normalized = normalizeMessagePresentation(structuredClone(presentation));
    expect(normalized).toEqual(presentation);
    const [command, callback, approval, url, webApp] = presentation.blocks[0]!.buttons;
    expect(presentationToInteractiveReply(normalized!)).toEqual(
      buttonPresentation(
        { ...command, value: "/codex plugins menu" },
        { ...callback, value: "/approve req allow-once" },
        approval,
        { ...url, url: "https://example.com/approve/id" },
        { ...webApp, webApp: { url: "https://example.com/app" } },
      ),
    );
  });

  it("requires a web-app target and preserves hosted widget ids", () => {
    const normalized = normalizeMessagePresentation(
      buttonPresentation(
        {
          label: "Hosted widget",
          action: { type: "web-app", widgetId: " AAAAAAAAAAAAAAAAAAAAAA " },
        },
        {
          label: "Hosted fallback",
          action: {
            type: "web-app",
            widgetId: "BBBBBBBBBBBBBBBBBBBBBB",
            url: " https://example.com/app ",
          },
        },
      ),
    );

    const expected = buttonPresentation(
      {
        label: "Hosted widget",
        action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
      },
      {
        label: "Hosted fallback",
        action: {
          type: "web-app",
          widgetId: "BBBBBBBBBBBBBBBBBBBBBB",
          url: "https://example.com/app",
        },
      },
    );
    expect(normalized).toEqual(expected);
    const [widget, fallback] = expected.blocks[0]!.buttons;
    const interactive = presentationToInteractiveReply(normalized!);
    expect(interactive?.blocks[0]).toMatchObject({
      type: "buttons",
      buttons: [widget, { ...fallback, webApp: { url: "https://example.com/app" } }],
    });
    expect(interactive?.blocks[0]).not.toHaveProperty("buttons.0.webApp");
    expect(renderMessagePresentationFallbackText({ presentation: normalized })).toBe(
      "- Hosted widget\n- Hosted fallback: https://example.com/app",
    );
    expect(
      resolveMessagePresentationButtonAction({
        // Boundary input missing both url and widgetId; the union forbids this statically.
        action: { type: "web-app" } as unknown as MessagePresentationAction,
      }),
    ).toBeUndefined();
    expect(
      normalizeMessagePresentation(
        buttonPresentation({ label: "Missing", action: { type: "web-app" } }),
      ),
    ).toBeUndefined();
  });

  it("normalizes every model-picker intent and preserves typed bridges", () => {
    const base = { type: "model-picker", version: 1, snapshotToken: "snapshot_1" } as const;
    const model = { providerToken: "p", modelToken: "m" } as const;
    const actions = [
      { ...base, intent: "show-providers", cursor: "page_2" },
      { ...base, intent: "show-models", providerToken: "p", cursor: "page_3" },
      { ...base, intent: "show-recents" },
      { ...base, ...model, intent: "choose-model" },
      { ...base, ...model, intent: "choose-runtime", runtimeToken: "r" },
      { ...base, intent: "reset" },
      { ...base, intent: "cancel" },
    ] satisfies ModelPickerAction[];

    for (const action of actions) {
      expect(resolveMessagePresentationOptionAction({ action }, { modelPicker: true })).toEqual(
        action,
      );
    }
    const action = actions[3]!;
    expect(resolveMessagePresentationButtonAction({ action })).toBeUndefined();
    const presentation = normalizeMessagePresentation({
      blocks: [
        { type: "buttons", buttons: [{ label: "Model", action }] },
        { type: "select", options: [{ label: "Model", action }] },
      ],
    });
    const bridged = presentationToInteractiveReply(presentation!);
    expect(bridged?.blocks[0]).toMatchObject({ buttons: [{ action }] });
    expect(bridged?.blocks[1]).toMatchObject({ options: [{ action }] });
    expect(presentationToInteractiveControlsReply(presentation!)).toEqual(bridged);
    expect(resolveMessagePresentationControlValue({ action })).toBeUndefined();
    const invalid = [
      { ...base, version: 2, intent: "cancel" },
      { ...base, intent: "submit" },
      { type: "model-picker", version: 1, intent: "cancel" },
      { ...base, intent: "choose-model", providerToken: "p", modelToken: "openai/gpt" },
      { ...base, intent: "show-models" },
      { ...base, intent: "choose-runtime", providerToken: "p", modelToken: "m" },
      { ...base, snapshotToken: "x".repeat(129), intent: "cancel" },
    ];
    for (const invalidAction of invalid) {
      const malformed = { action: invalidAction } as never;
      expect(
        resolveMessagePresentationButtonAction(malformed, { modelPicker: true }),
      ).toBeUndefined();
    }
  });

  it("resolves deprecated button inputs without overriding a canonical action", () => {
    expect(
      resolveMessagePresentationButtonAction({
        action: {
          type: "approval",
          approvalId: "approval:1",
          approvalKind: "plugin",
          decision: "deny",
        },
        value: "legacy",
        url: "https://ignored.example",
      }),
    ).toEqual({
      type: "approval",
      approvalId: "approval:1",
      approvalKind: "plugin",
      decision: "deny",
    });
    expect(
      resolveMessagePresentationButtonAction({
        value: "legacy",
        url: "https://example.com",
        webApp: { url: "https://app.example.com" },
      }),
    ).toEqual({ type: "url", url: "https://example.com" });
    expect(
      resolveMessagePresentationButtonAction({
        value: "legacy",
        web_app: { url: "https://app.example.com" },
      }),
    ).toEqual({ type: "web-app", url: "https://app.example.com" });
    expect(resolveMessagePresentationButtonAction({ value: "legacy" })).toEqual({
      type: "callback",
      value: "legacy",
    });
    expect(resolveMessagePresentationOptionAction({ value: "option" })).toEqual({
      type: "callback",
      value: "option",
    });
    const invalidButton = {
      action: null,
      value: "legacy",
      url: "https://legacy.example",
    } as unknown as Parameters<typeof resolveMessagePresentationButtonAction>[0];
    const invalidControl = {
      action: null,
      value: "legacy",
    } as unknown as Parameters<typeof resolveMessagePresentationControlValue>[0];
    const invalidOption = {
      action: null,
      value: "legacy",
    } as unknown as Parameters<typeof resolveMessagePresentationOptionAction>[0];
    expect(resolveMessagePresentationButtonAction(invalidButton)).toBeUndefined();
    expect(resolveMessagePresentationControlValue(invalidControl)).toBeUndefined();
    expect(resolveMessagePresentationOptionAction(invalidOption)).toBeUndefined();
  });

  it("does not restore deprecated select values behind invalid explicit actions", () => {
    const presentation = {
      blocks: [
        {
          type: "select",
          options: [{ label: "Invalid", action: null, value: "legacy" }],
        },
      ],
    } as unknown as Parameters<typeof presentationToInteractiveReply>[0];

    const interactive = presentationToInteractiveReply(presentation);
    expect(interactive?.blocks[0]).toMatchObject({
      type: "select",
      options: [{ label: "Invalid" }],
    });
    expect(interactive?.blocks[0]).not.toHaveProperty("options.0.value");
  });

  it("never exposes approval data through generic scalar resolution or fallback text", () => {
    const action = {
      type: "approval" as const,
      approvalId: "approval:secret-transport-id",
      approvalKind: "plugin" as const,
      decision: "allow-always" as const,
    };
    const button = {
      label: "Approve",
      action,
      value: "legacy-shadow",
      url: "https://ignored.example",
    };
    const presentation = buttonPresentation(button);
    expect(resolveMessagePresentationControlValue(button)).toBeUndefined();
    expect(renderMessagePresentationFallbackText({ presentation })).toBe("- Approve");
    expect(presentationToInteractiveReply(presentation)).toEqual(
      buttonPresentation({ label: "Approve", action }),
    );
  });

  it("normalizes question actions without exposing their transport data", () => {
    const action = {
      type: "question" as const,
      questionId: "ask_0123456789abcdef0123456789abcdef",
      optionValue: "Production",
    };
    const presentation = normalizeMessagePresentation(
      buttonPresentation({ label: "Production", action }),
    );

    expect(presentation).toEqual(buttonPresentation({ label: "Production", action }));
    expect(resolveMessagePresentationControlValue({ action })).toBeUndefined();
    expect(renderMessagePresentationFallbackText({ presentation: presentation ?? undefined })).toBe(
      "- Production",
    );
    expect(presentationToInteractiveReply(presentation ?? { blocks: [] })).toEqual(
      buttonPresentation({ label: "Production", action }),
    );
  });

  it.each([
    { type: "Question", questionId: "ask_1", optionValue: "Yes" },
    { type: "question", questionId: "", optionValue: "Yes" },
    { type: "question", questionId: "ask_\ud800", optionValue: "Yes" },
    { type: "question", questionId: "ask_1", optionValue: "   " },
  ])("rejects malformed question action %#", (action) => {
    expect(
      normalizeMessagePresentation(buttonPresentation({ label: "Yes", action })),
    ).toBeUndefined();
  });

  it("rejects malformed canonical actions instead of falling back to legacy fields", () => {
    const approval = {
      type: "approval",
      approvalId: "approval:1",
      approvalKind: "exec",
      decision: "allow-once",
    };
    for (const action of [
      { ...approval, decision: "yes" },
      { ...approval, approvalId: "\ud800" },
      {
        type: " APPROVAL ",
        approvalId: " approval:1 ",
        approvalKind: " EXEC ",
        decision: " ALLOW-ONCE ",
      },
    ]) {
      expect(
        normalizeMessagePresentation(
          buttonPresentation({ label: "Approve", action, value: "legacy" }),
        ),
      ).toBeUndefined();
    }
    expect(
      normalizeMessagePresentation({
        blocks: [
          { type: "select", options: [{ label: "Approve", action: approval, value: "legacy" }] },
        ],
      }),
    ).toBeUndefined();
  });

  it("preserves protocol-valid boundary whitespace in typed approval actions", () => {
    const action = {
      type: "approval",
      approvalId: "\uFEFF",
      approvalKind: "exec",
      decision: "deny",
    } as const;
    const expected = buttonPresentation({ label: "Deny", action });
    expect(normalizeMessagePresentation(structuredClone(expected))).toEqual(expected);
  });

  it("converts only presentation controls for native component renderers", () => {
    const controls = [
      {
        type: "buttons",
        buttons: [{ label: "Approve", value: "approve", style: "success", reusable: true }],
      },
      {
        type: "select",
        placeholder: "Rollback target",
        options: [{ label: "Previous", value: "previous" }],
      },
    ] satisfies MessagePresentationBlock[];
    const presentation = {
      title: "Deploy approval",
      blocks: [
        { type: "text" as const, text: "Canary is ready." },
        { type: "divider" as const },
        ...structuredClone(controls),
      ],
    };

    expect(presentationToInteractiveReply(presentation)).toEqual({
      blocks: [
        { type: "text", text: "Deploy approval" },
        { type: "text", text: "Canary is ready." },
        ...controls,
      ],
    });
    expect(presentationToInteractiveControlsReply(presentation)).toEqual({ blocks: controls });
  });

  it("preserves command values in button fallback text while keeping callback values private", () => {
    const presentation = buttonPresentation(
      { label: "Approve", value: "/approve req_1 allow-once" },
      { label: "Deny", action: { type: "command" as const, command: "/approve req_1 deny" } },
      { label: "Ignore", action: { type: "callback" as const, value: "ignore_123" } },
      { label: "Docs", url: "https://example.com/docs" },
      {
        label: "Legacy link override",
        action: { type: "command" as const, command: "/approve req_1" },
        url: "https://example.com/review",
      },
      { label: "Disabled", disabled: true },
      {
        label: "DisabledCmd",
        disabled: true,
        action: { type: "command" as const, command: "/test" },
      },
    );

    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      [
        "- Approve",
        "- Deny: `/approve req_1 deny`",
        "- Ignore",
        "- Docs: https://example.com/docs",
        "- Legacy link override: `/approve req_1`",
        "- Disabled",
        "- DisabledCmd",
      ].join("\n"),
    );
  });

  it("keeps divider-only fallback empty unless a send transport fallback is requested", () => {
    const presentation = {
      blocks: [{ type: "divider" as const }],
    };

    expect(renderMessagePresentationFallbackText({ presentation })).toBe("");
    expect(
      renderMessagePresentationFallbackText({
        presentation,
        emptyFallback: "---",
      }),
    ).toBe("---");
  });

  it("normalizes chart data and renders deterministic accessible fallback text", () => {
    const blocks = [
      {
        type: "chart",
        chartType: "pie",
        title: "Requests by region",
        segments: [
          { label: "Americas", value: 52 },
          { label: "Europe", value: 31 },
        ],
      },
      {
        type: "chart",
        chartType: "line",
        title: "Weekly latency",
        categories: ["Mon", "Tue"],
        series: [
          { name: "p50", values: [120, 110] },
          { name: "p95", values: [250, 230] },
        ],
        xLabel: "Day",
        yLabel: "Milliseconds",
      },
    ] satisfies MessagePresentationBlock[];
    const presentation = normalizeMessagePresentation({ blocks: structuredClone(blocks) });
    expect(presentation).toEqual({ blocks });
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(
      [
        "Requests by region (pie chart)",
        "- Americas: 52",
        "- Europe: 31",
        "",
        "Weekly latency (line chart)",
        "X axis: Day",
        "Y axis: Milliseconds",
        "- p50: Mon: 120; Tue: 110",
        "- p95: Mon: 250; Tue: 230",
      ].join("\n"),
    );
    expect(presentationToInteractiveReply(presentation!)).toEqual({
      blocks: [
        {
          type: "text",
          text: "Requests by region (pie chart)\n- Americas: 52\n- Europe: 31",
        },
        {
          type: "text",
          text: [
            "Weekly latency (line chart)",
            "X axis: Day",
            "Y axis: Milliseconds",
            "- p50: Mon: 120; Tue: 110",
            "- p95: Mon: 250; Tue: 230",
          ].join("\n"),
        },
      ],
    });
  });

  it.each([
    {
      name: "non-positive pie values",
      block: {
        type: "chart",
        chartType: "pie",
        title: "Invalid",
        segments: [{ label: "Zero", value: 0 }],
      },
    },
    {
      name: "duplicate categories",
      block: {
        type: "chart",
        chartType: "bar",
        title: "Invalid",
        categories: ["Q1", "Q1"],
        series: [{ name: "Revenue", values: [1, 2] }],
      },
    },
    {
      name: "mismatched series values",
      block: {
        type: "chart",
        chartType: "area",
        title: "Invalid",
        categories: ["Q1", "Q2"],
        series: [{ name: "Revenue", values: [1] }],
      },
    },
    {
      name: "duplicate series names",
      block: {
        type: "chart",
        chartType: "line",
        title: "Invalid",
        categories: ["Q1"],
        series: [
          { name: "Revenue", values: [1] },
          { name: "Revenue", values: [2] },
        ],
      },
    },
  ])("drops chart blocks with $name instead of changing their data", ({ block }) => {
    expect(normalizeMessagePresentation({ blocks: [block] })).toBeUndefined();
  });

  it("normalizes tables and renders deterministic linear fallback text", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: " Pipeline report ",
          headers: [" Account ", "Stage", "ARR"],
          rows: [
            [" Acme\nCorp ", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
          rowHeaderColumnIndex: 0,
        },
      ],
    });

    expect(presentation).toEqual({
      blocks: [
        {
          type: "table",
          caption: "Pipeline report",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme\nCorp", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
          rowHeaderColumnIndex: 0,
        },
      ],
    });
    const fallback = [
      "Pipeline report (table)",
      "- Account: Acme Corp; Stage: Won; ARR: 125000",
      "- Account: Globex; Stage: Review; ARR: 82000",
    ].join("\n");
    expect(renderMessagePresentationFallbackText({ presentation })).toBe(fallback);
    expect(presentationToInteractiveReply(presentation!)).toEqual({
      blocks: [{ type: "text", text: fallback }],
    });
  });

  const table = { type: "table", caption: "Report", headers: ["Name"], rows: [["Acme"]] };
  it.each([
    { name: "missing caption", block: { ...table, caption: undefined } },
    { name: "empty headers", block: { ...table, headers: [] } },
    {
      name: "duplicate headers",
      block: { ...table, headers: ["Name", "Name"], rows: [["Acme", "Won"]] },
    },
    { name: "empty rows", block: { ...table, rows: [] } },
    { name: "mismatched row width", block: { ...table, headers: ["Name", "Stage"] } },
    { name: "empty string cell", block: { ...table, rows: [[" "]] } },
    { name: "non-finite numeric cell", block: { ...table, headers: ["ARR"], rows: [[Infinity]] } },
    { name: "non-scalar cell", block: { ...table, rows: [[true]] } },
    { name: "out-of-range row header column", block: { ...table, rowHeaderColumnIndex: 1 } },
  ])("drops table blocks with $name instead of repairing their data", ({ block }) => {
    expect(normalizeMessagePresentation({ blocks: [block] })).toBeUndefined();
  });
});
