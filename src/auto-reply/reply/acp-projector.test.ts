import { afterEach, describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

type Delivery = { kind: string; text?: string };

function createProjectorHarness(
  cfgOverrides?: Parameters<typeof createCfg>[0],
  opts?: {
    onProgress?: () => void;
    shouldSendToolSummariesNow?: () => boolean;
    shouldSendFullToolDetails?: boolean;
    getConversationContext?: () => string | undefined;
  },
) {
  const deliveries: Delivery[] = [];
  const projector = createAcpReplyProjector({
    cfg: createCfg(cfgOverrides),
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

function createStreamHarness(
  deliveryMode: "live" | "final_only",
  streamOverrides: Record<string, unknown> = {},
  opts?: Parameters<typeof createProjectorHarness>[1],
) {
  return createProjectorHarness(
    {
      acp: { enabled: true, stream: { deliveryMode, ...streamOverrides } },
    } as Parameters<typeof createCfg>[0],
    opts,
  );
}

function combinedBlockText(deliveries: Delivery[]) {
  return deliveries
    .filter((entry) => entry.kind === "block")
    .map((entry) => entry.text ?? "")
    .join("");
}

function expectToolCallSummary(delivery: Delivery | undefined) {
  expect(delivery?.kind).toBe("tool");
  expect(delivery?.text).toContain("Tool Call");
}

function createLiveToolLifecycleHarness() {
  return createStreamHarness("live", {
    tagVisibility: { tool_call: true, tool_call_update: true },
  });
}

type Projector = ReturnType<typeof createProjectorHarness>["projector"];
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

function emitUsage(projector: Projector, used: number) {
  return emitStatus(projector, `usage updated: ${used}/100`, "usage_update", { used, size: 100 });
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
    const { projector } = createProjectorHarness(undefined, { onProgress });

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

  it("preserves final-only text boundary when a buffered tool summary is dropped", async () => {
    let allowToolSummaries = true;
    const { deliveries, projector } = createStreamHarness(
      "final_only",
      { tagVisibility: { tool_call: true } },
      { shouldSendToolSummariesNow: () => allowToolSummaries },
    );

    await emitText(projector, "fallback.");
    await emitTool(projector);
    await emitText(projector, "I don't");
    allowToolSummaries = false;

    await projector.flush();

    expect(deliveries).toEqual([{ kind: "final", text: "fallback.\n\nI don't" }]);
  });

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    const { deliveries, projector } = createStreamHarness("live");

    await emitText(projector, "Yes. Send me the term(s), and I’ll run ");

    await vi.advanceTimersByTimeAsync(1200);
    expect(deliveries).toStrictEqual([]);

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
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
    expect(deliveries[2]).toEqual({ kind: "final", text: "What now?" });
  });

  it("suppresses usage_update by default and allows deduped usage when tag-visible", async () => {
    const { deliveries: hidden, projector: hiddenProjector } = createProjectorHarness();
    await emitUsage(hiddenProjector, 10);
    expect(hidden).toStrictEqual([]);

    const { deliveries: shown, projector: shownProjector } = createStreamHarness("live", {
      tagVisibility: { usage_update: true },
    });

    await emitUsage(shownProjector, 10);
    await emitUsage(shownProjector, 10);
    await emitUsage(shownProjector, 11);

    expect(shown).toEqual([
      { kind: "tool", text: prefixSystemMessage("usage updated: 10/100") },
      { kind: "tool", text: prefixSystemMessage("usage updated: 11/100") },
    ]);
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
      const { deliveries, projector } = createLiveToolLifecycleHarness();
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

  it("suppresses exact duplicate status updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createStreamHarness("live", {
      tagVisibility: { available_commands_update: true },
    });

    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitStatus(projector, "available commands updated (8)", "available_commands_update");

    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: prefixSystemMessage("available commands updated (8)") },
    ]);
  });

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

    expect(deliveries.length).toBe(1);
    expectToolCallSummary(deliveries[0]);
  });

  it("preserves hidden boundary when the dynamic tool-summary gate hides a visible tool event", async () => {
    const { deliveries, projector } = createStreamHarness(
      "live",
      { tagVisibility: { tool_call: true } },
      {
        shouldSendToolSummariesNow: () => false,
      },
    );

    await emitText(projector, "fallback.");
    await emitTool(projector);
    await emitText(projector, "I don't");
    await projector.flush();

    expect(combinedBlockText(deliveries)).toBe("fallback. I don't");
    expect(deliveries.some((delivery) => delivery.kind === "tool")).toBe(false);
  });

  it("preserves hidden boundary across nonterminal hidden tool updates", async () => {
    const { deliveries, projector } = createStreamHarness("live", {
      tagVisibility: { tool_call: false, tool_call_update: false },
    });
    await emitText(projector, "fallback.");
    await emitTool(projector);
    await emitTool(projector, { tag: "tool_call_update" });
    await emitText(projector, "I don't");
    await projector.flush();
    expect(combinedBlockText(deliveries)).toBe("fallback. I don't");
  });
});
