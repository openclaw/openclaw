import { afterEach, describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

type Delivery = { kind: string; text?: string };
type Stream = NonNullable<NonNullable<ReturnType<typeof createCfg>["acp"]>["stream"]>;

function createStreamHarness(
  deliveryMode?: Stream["deliveryMode"],
  streamOverrides: Omit<Stream, "deliveryMode"> = {},
  opts?: {
    onProgress?: () => void;
    shouldSendToolSummariesNow?: () => boolean;
    shouldSendFullToolDetails?: boolean;
    getConversationContext?: () => string | undefined;
  },
) {
  const deliveries: Delivery[] = [];
  const projector = createAcpReplyProjector({
    cfg: createCfg(
      deliveryMode
        ? { acp: { enabled: true, stream: { deliveryMode, ...streamOverrides } } }
        : undefined,
    ),
    shouldSendToolSummaries: async () => opts?.shouldSendToolSummariesNow?.() ?? true,
    shouldSendFullToolDetails: async () => opts?.shouldSendFullToolDetails ?? false,
    deliver: async (kind, payload) => {
      deliveries.push({ kind, text: payload.text });
      return true;
    },
    getConversationContext: opts?.getConversationContext,
    onProgress: opts?.onProgress,
  });
  return { deliveries, projector };
}

function combinedBlockText(deliveries: Delivery[]) {
  return deliveries
    .filter((entry) => entry.kind === "block")
    .map((entry) => entry.text ?? "")
    .join("");
}

type Projector = ReturnType<typeof createStreamHarness>["projector"];
type ProjectorEvent = Parameters<Projector["onEvent"]>[0];
type EventOf<T extends ProjectorEvent["type"]> = Extract<ProjectorEvent, { type: T }>;

function emitText(
  projector: Projector,
  text: string,
  overrides: Partial<Omit<EventOf<"text_delta">, "type" | "text">> = {},
) {
  return projector.onEvent({ type: "text_delta", text, tag: "agent_message_chunk", ...overrides });
}

function emitStatus(
  projector: Projector,
  text: string,
  tag: EventOf<"status">["tag"],
  overrides: Partial<Omit<EventOf<"status">, "type" | "text" | "tag">> = {},
) {
  return projector.onEvent({ type: "status", text, tag, ...overrides });
}

function emitTool(projector: Projector, event: Partial<Omit<EventOf<"tool_call">, "type">> = {}) {
  const {
    tag = "tool_call",
    toolCallId = "call_1",
    status = "in_progress",
    title = "Run test",
    text = `${title} (${status})`,
    ...rest
  } = event;
  return projector.onEvent({ type: "tool_call", tag, toolCallId, status, title, text, ...rest });
}

describe("createAcpReplyProjector", () => {
  afterEach(() => vi.useRealTimers());
  it.each([false, true])("shows execute details only in full verbose mode: %s", async (verbose) => {
    const { deliveries, projector } = createStreamHarness(
      "live",
      { tagVisibility: { tool_call: true } },
      { shouldSendFullToolDetails: verbose },
    );
    await emitTool(projector, {
      kind: "execute",
      title: "exec: cat /private/operator-file",
    });
    if (verbose) {
      expect(deliveries[0]?.text).toContain("cat /private/operator-file");
    } else {
      expect(deliveries[0]?.text).not.toContain("cat /private/operator-file");
      expect(deliveries[0]?.text).toContain("status=in_progress");
    }
  });

  it("reports progress for ACP runtime events before delivery filtering", async () => {
    const onProgress = vi.fn();
    const { projector } = createStreamHarness(undefined, {}, { onProgress });

    await emitText(projector, "hidden reasoning", { stream: "thought" });
    await emitTool(projector, {
      title: "Run command",
      text: "Run command",
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("bounds output and reports truncation once in live mode", async () => {
    vi.useFakeTimers();
    const { deliveries, projector } = createStreamHarness("live");
    const inputText = Array.from({ length: 4_001 }, (_, index) =>
      String(index).padStart(6, "0"),
    ).join("");
    await emitText(projector, inputText);
    await emitText(projector, "discarded after the limit");
    await projector.flush();

    const output = deliveries.filter(({ kind }) => kind !== "tool");
    expect(output.map(({ text }) => text).join("")).toBe(inputText.slice(0, 24_000));
    for (const { kind, text } of output) {
      expect(kind).toBe("block");
      expect(text?.length).toBeLessThanOrEqual(1800);
    }
    expect(deliveries.filter(({ kind }) => kind === "tool")).toEqual([
      { kind: "tool", text: prefixSystemMessage("output truncated") },
    ]);
  });

  it.each(["live", "final_only"] as const)(
    "uses finalized and refreshed owner context to redact split private prompts in %s mode",
    async (deliveryMode) => {
      const marker = "[Current message - respond to this]";
      let conversationContext = "";
      const { deliveries, projector } = createStreamHarness(
        deliveryMode,
        {},
        {
          getConversationContext: () => conversationContext,
        },
      );
      conversationContext = `${marker}\nPrivate secret. Keep hidden.`;

      await emitText(projector, "Visible answer before. ");
      conversationContext = `${marker}\nPrivate updated context. Keep hidden.`;
      await emitText(projector, `${marker}\nPrivate updated context. `);
      await emitText(projector, "Keep hidden. Visible answer after.");
      await projector.flush();

      expect(deliveries.map((delivery) => delivery.text).join("")).toBe(
        "Visible answer before.  Visible answer after.",
      );
    },
  );

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    const { deliveries, projector } = createStreamHarness("live");

    await emitText(projector, "Yes. Send me the term(s), and I’ll run ");

    await vi.advanceTimersByTimeAsync(1200);
    expect(deliveries).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    await emitText(projector, "`wd-cli` searches right away. ");
    await projector.flush();

    expect(deliveries).toEqual([
      {
        kind: "block",
        text: "Yes. Send me the term(s), and I’ll run `wd-cli` searches right away. ",
      },
    ]);
  });

  it("supports deliveryMode=final_only by buffering all projected output until done", async () => {
    const { deliveries, projector } = createStreamHarness("final_only", {
      tagVisibility: { available_commands_update: true, tool_call: true },
    });

    await emitText(projector, "What");
    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitTool(projector, { title: "List files" });
    await emitText(projector, " now?");
    expect(deliveries).toStrictEqual([]);

    await projector.flush();
    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: expect.stringContaining("Tool Call") },
      { kind: "final", text: "What now?" },
    ]);
  });

  it.each([
    ["usage_update", 10, "usage updated: 10/100", "usage updated: 11/100"],
    [
      "available_commands_update",
      7,
      "available commands updated (7)",
      "available commands updated (8)",
    ],
  ] as const)("suppresses repeated %s updates", async (tag, value, first, next) => {
    const emit = (projector: Projector, text: string, used: number) =>
      emitStatus(projector, text, tag, tag === "usage_update" ? { used, size: 100 } : {});
    if (tag === "usage_update") {
      const { deliveries, projector } = createStreamHarness();
      await emit(projector, first, value);
      expect(deliveries).toStrictEqual([]);
    }
    const { deliveries, projector } = createStreamHarness("live", {
      tagVisibility: { [tag]: true },
    });
    await emit(projector, first, value);
    await emit(projector, first, value);
    await emit(projector, next, value + 1);
    expect(deliveries).toEqual(
      [first, next].map((text) => ({ kind: "tool", text: prefixSystemMessage(text) })),
    );
  });

  it.each([
    { title: "List files", text: "Tool Call: List files · status=in_progress" },
    {
      title:
        "Run an intentionally long command title that truncates before lifecycle status is visible",
      text: expect.stringContaining("Tool Call"),
    },
  ])(
    "dedupes lifecycle updates without dropping the terminal update: $title",
    async ({ title, text }) => {
      const { deliveries, projector } = createStreamHarness("live", {
        tagVisibility: { tool_call: true, tool_call_update: true },
      });
      await emitTool(projector, { title });
      await emitTool(projector, { tag: "tool_call_update", title });
      await emitTool(projector, { tag: "tool_call_update", status: "completed", title });
      await emitTool(projector, { tag: "tool_call_update", status: "completed", title });

      expect(deliveries).toEqual([
        { kind: "tool", text },
        { kind: "tool", text: expect.stringContaining("Tool Call") },
      ]);
    },
  );

  it("supports tagVisibility overrides for tool updates", async () => {
    const { deliveries, projector } = createStreamHarness("live", {
      tagVisibility: { tool_call: true, tool_call_update: false },
    });

    await emitTool(projector, { title: "Run tests" });
    await emitTool(projector, {
      tag: "tool_call_update",
      status: "completed",
      title: "Run tests",
    });

    expect(deliveries).toEqual([{ kind: "tool", text: expect.stringContaining("Tool Call") }]);
  });

  it.each([
    ["buffered summary dropped at flush", "final_only", true],
    ["dynamic summary gate", "live", true],
    ["nonterminal hidden updates", "live", false],
  ] as const)("preserves text boundaries across %s", async (_name, mode, visible) => {
    let allowToolSummaries = mode === "final_only" || !visible;
    const { deliveries, projector } = createStreamHarness(
      mode,
      { tagVisibility: { tool_call: visible, tool_call_update: false } },
      { shouldSendToolSummariesNow: () => allowToolSummaries },
    );
    await emitText(projector, "fallback.");
    await emitTool(projector);
    if (!visible) {
      await emitTool(projector, { tag: "tool_call_update" });
    }
    await emitText(projector, "I don't");
    if (mode === "final_only") {
      allowToolSummaries = false;
    }
    await projector.flush();
    if (mode === "final_only") {
      expect(deliveries).toEqual([{ kind: "final", text: "fallback.\n\nI don't" }]);
    } else {
      expect(combinedBlockText(deliveries)).toBe("fallback. I don't");
      if (visible) {
        expect(deliveries.some((delivery) => delivery.kind === "tool")).toBe(false);
      }
    }
  });
});
