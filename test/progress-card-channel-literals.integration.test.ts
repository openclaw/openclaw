import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDiscordDraftPreview, RequestClient } from "../extensions/discord/test-api.js";
import {
  renderTelegramProgressDraftPreview,
  telegramHtmlToPlainTextFallback,
} from "../extensions/telegram/test-api.js";
import { markdownToIR } from "../packages/markdown-core/src/ir.js";
import { createSubscribedSessionHarness } from "../src/agents/embedded-agent-subscribe.e2e-harness.js";
import { createOpenClawTools } from "../src/agents/openclaw-tools.js";
import type { InProcessGatewayCaller } from "../src/agents/tools/in-process-gateway.js";
import { createChannelProgressDraftCompositor } from "../src/channels/progress-draft-compositor.js";
import { normalizeAgentPlanSteps } from "../src/channels/streaming.js";

const { createDiscordDraftPreviewController } = await loadDiscordDraftPreview();

const gatewayCall = vi.hoisted(() => vi.fn<InProcessGatewayCaller>());
vi.mock("../src/agents/tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agents/tools/in-process-gateway.js")>()),
  callInProcessGatewayTool: gatewayCall,
}));

afterEach(() => vi.clearAllMocks());

const cases = [
  {
    markdown: "Use `**literal**` now.",
    text: "Use **literal** now.",
    html: "Use **literal** now.",
  },
  {
    markdown: "Use `[label](https://example.com)` literally.",
    text: "Use [label](https://example.com) literally.",
    html: "Use [label](https://example.com) literally.",
  },
  {
    markdown: "Use `<b>literal</b>` now.",
    text: "Use <b>literal</b> now.",
    html: "Use &lt;b&gt;literal&lt;/b&gt; now.",
  },
  {
    markdown: "Use &lt;b&gt;literal&lt;/b&gt; now.",
    text: "Use <b>literal</b> now.",
    html: "Use &lt;b&gt;literal&lt;/b&gt; now.",
  },
];

async function runRegisteredCard(
  markdown: string,
  pushPlanProgress: ReturnType<typeof createChannelProgressDraftCompositor>["pushPlanProgress"],
) {
  gatewayCall.mockResolvedValue({
    card: { sessionKey: "agent:main:literal-test", revision: 1, updatedAt: 1, markdown },
  });
  const tool = createOpenClawTools({
    agentSessionKey: "agent:main:literal-test",
    config: { tools: { allow: ["progress_card"] } },
  }).find((entry) => entry.name === "progress_card");
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("progress_card is not registered");
  }
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "literal-test",
    sessionPersistence: "detached",
    onAgentEvent: async (event) => {
      if (event.stream === "plan") {
        await pushPlanProgress(normalizeAgentPlanSteps(event.data.steps), {
          explanation:
            typeof event.data.explanation === "string" ? event.data.explanation : undefined,
          explanationFormat: event.data.explanationFormat === "plain" ? "plain" : undefined,
        });
      }
    },
  });
  try {
    emit({
      type: "tool_execution_start",
      toolName: tool.name,
      toolCallId: "card-1",
      args: { markdown },
    });
    await subscription.waitForPendingEvents();
    const result = await tool.execute("card-1", { markdown });
    emit({
      type: "tool_execution_end",
      toolName: tool.name,
      toolCallId: "card-1",
      result,
      isError: false,
    });
    await subscription.waitForPendingEvents();
    expect(gatewayCall).toHaveBeenCalledWith(
      "progressCard.put",
      expect.objectContaining({ markdown, sessionKey: "agent:main:literal-test" }),
    );
  } finally {
    subscription.unsubscribe();
  }
}

describe("registered progress cards at the final channel renderer", () => {
  it.each(cases)(
    "keeps Discord code and decoded text literal: $markdown",
    async ({ markdown, text }) => {
      const messages: string[] = [];
      const rest = new RequestClient("test-token", {
        queueRequests: false,
        fetch: async (_input, init) => {
          if (init?.method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          if (typeof init?.body !== "string") {
            throw new Error("Expected a serialized message");
          }
          const body: unknown = JSON.parse(init.body);
          if (
            !body ||
            typeof body !== "object" ||
            !("content" in body) ||
            typeof body.content !== "string"
          ) {
            throw new Error("Expected Discord message content");
          }
          messages.push(body.content);
          return Response.json({ id: "literal-draft" });
        },
      });
      const controller = createDiscordDraftPreviewController({
        cfg: {},
        discordConfig: { streaming: { mode: "progress", progress: { label: false } } },
        accountId: "default",
        sourceRepliesAreToolOnly: false,
        textLimit: 2000,
        deliveryRest: rest,
        deliverChannelId: "test-channel",
        replyReference: { peek: () => undefined },
        tableMode: "off",
        maxLinesPerMessage: undefined,
        chunkMode: "length",
        log: () => {},
      });
      try {
        await runRegisteredCard(markdown, controller.pushPlanProgress);
        await controller.flush();
        expect(messages).toHaveLength(1);
        const rendered = markdownToIR(messages[0] ?? "", { autolink: true, linkify: true });
        expect(rendered.text.trim()).toBe(text);
        expect(rendered.styles).toEqual([]);
        expect(rendered.links).toEqual([]);
        expect(messages[0]).not.toContain("https://");
      } finally {
        await controller.cleanup();
      }
    },
  );

  it.each(
    cases.flatMap(({ markdown, text, html }) =>
      [false, true].map((richMessages) => ({ markdown, text, html, richMessages })),
    ),
  )(
    "keeps Telegram literal text and inactive links (rich=$richMessages): $markdown",
    async ({ markdown, text, html, richMessages }) => {
      const previews: ReturnType<typeof renderTelegramProgressDraftPreview>[] = [];
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: false } } },
        mode: "progress",
        active: true,
        seed: "literal-test",
        update: (_text, { snapshot }) => {
          previews.push(
            renderTelegramProgressDraftPreview(snapshot, {
              richMessages,
              toolProgress: true,
              maxLines: 8,
              maxLineChars: 240,
            }),
          );
          return true;
        },
      });
      try {
        await runRegisteredCard(markdown, progress.pushPlanProgress.bind(progress));
        expect(previews).toHaveLength(1);
        const preview = previews[0];
        if (richMessages) {
          expect(preview?.text).toBe(text);
          expect(preview?.richMessage).toEqual({
            blocks: [{ type: "paragraph", text: { type: "code", text } }],
            skip_entity_detection: true,
          });
        } else {
          expect(preview?.text).toBe(`<code>${html}</code>`);
          expect(telegramHtmlToPlainTextFallback(preview?.text ?? "")).toBe(text);
          expect(preview?.text).not.toContain("href=");
        }
      } finally {
        progress.cancel();
      }
    },
  );
});
