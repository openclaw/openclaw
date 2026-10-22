import { assert, expect, it } from "vitest";
import { loadDiscordDraftPreview, RequestClient } from "../extensions/discord/test-api.js";
import {
  renderTelegramProgressDraftPreview,
  telegramHtmlToPlainTextFallback,
} from "../extensions/telegram/test-api.js";
import { markdownToIR } from "../packages/markdown-core/src/ir.js";
import { createChannelProgressDraftCompositor } from "../src/channels/progress-draft-compositor.js";
import { projectProgressCardChannelUpdate } from "../src/session-cards/progress-card-channel-summary.js";

const { createDiscordDraftPreviewController } = await loadDiscordDraftPreview();

const literal = (markdown: string, text: string, html = text) => ({ markdown, text, html });
const cases = [
  literal("A `**B**` C", "A **B** C"),
  literal("A `[B](https://example.com)` C", "A [B](https://example.com) C"),
  literal("A `<b>B</b>` C", "A <b>B</b> C", "A &lt;b&gt;B&lt;/b&gt; C"),
  literal("A &lt;b&gt;B&lt;/b&gt; C", "A <b>B</b> C", "A &lt;b&gt;B&lt;/b&gt; C"),
];

type PushPlan = ReturnType<typeof createChannelProgressDraftCompositor>["pushPlanProgress"];
async function pushCard(markdown: string, pushPlanProgress: PushPlan) {
  const projected = projectProgressCardChannelUpdate({ markdown });
  assert(projected, "Expected a valid progress card");
  await pushPlanProgress(projected.steps, projected);
}

it.for(cases)(
  "keeps Discord code and decoded text literal: $markdown",
  async ({ markdown, text }, { onTestFinished }) => {
    const messages: string[] = [];
    const rest = new RequestClient("test-token", {
      queueRequests: false,
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        assert(typeof init?.body === "string", "Expected a serialized message");
        const body: unknown = JSON.parse(init.body);
        assert(
          body && typeof body === "object" && "content" in body && typeof body.content === "string",
          "Expected Discord message content",
        );
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
      log: () => {},
    });
    onTestFinished(() => controller.cleanup());
    await pushCard(markdown, controller.pushPlanProgress);
    await controller.flush();
    expect(messages).toHaveLength(1);
    const rendered = markdownToIR(messages[0] ?? "", { autolink: true, linkify: true });
    const { text: plain, styles, links } = rendered;
    expect({ text: plain.trim(), styles, links }).toEqual({ text, styles: [], links: [] });
    expect(messages[0]).not.toContain("https://");
  },
);

it.for(
  cases.flatMap(({ markdown, text, html }) =>
    [false, true].map((richMessages) => ({ markdown, text, html, richMessages })),
  ),
)(
  "keeps Telegram notes literal with headline styling (rich=$richMessages): $markdown",
  async ({ markdown, text, html, richMessages }, { onTestFinished }) => {
    const previews: ReturnType<typeof renderTelegramProgressDraftPreview>[] = [];
    const options = { richMessages, toolProgress: true, maxLines: 8, maxLineChars: 240 };
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      mode: "progress",
      active: true,
      seed: "literal-test",
      update: (_text, { snapshot }) => {
        previews.push(renderTelegramProgressDraftPreview(snapshot, options));
        return true;
      },
    });
    onTestFinished(() => progress.cancel());
    await pushCard(markdown, progress.pushPlanProgress.bind(progress));
    expect(previews).toHaveLength(1);
    const preview = previews[0];
    if (richMessages) {
      expect(preview?.text).toBe(text);
      expect(preview?.richMessage).toEqual({
        blocks: [{ type: "paragraph", text: { type: "bold", text } }],
        skip_entity_detection: true,
      });
    } else {
      expect(preview?.text).toBe(`<b>${html}</b>`);
      expect(telegramHtmlToPlainTextFallback(preview?.text ?? "")).toBe(text);
      expect(preview?.text).not.toContain("href=");
    }
  },
);
