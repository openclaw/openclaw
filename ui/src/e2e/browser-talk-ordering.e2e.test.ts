import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createTalkRegressionSuite,
  installTalkGateway,
} from "./browser-talk-regression.test-support.ts";
import {
  dispatchOpenAiTalkEvent,
  installOpenAiTalkFixture,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { composer } from "./chat-flow-fixtures.test-support.ts";
const suite = createTalkRegressionSuite("Control UI browser Talk transcript ordering");

async function startTalk(page: Page, voiceSessionId: string) {
  const gateway = await installTalkGateway(page, voiceSessionId);
  await installOpenAiTalkFixture(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForTalkReady(page);
  await page.getByRole("button", { name: "Start voice input" }).click();
  await gateway.waitForRequest("talk.client.create");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (
            window as Window & {
              openclawVideoTalkE2e?: { peer: { remoteDescription: unknown } };
            }
          ).openclawVideoTalkE2e?.peer.remoteDescription,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    (
      window as Window & {
        openclawVideoTalkE2e?: { peer: { channel: EventTarget } };
      }
    ).openclawVideoTalkE2e?.peer.channel.dispatchEvent(new Event("open"));
  });
  return gateway;
}

suite.define(() => {
  it("renders and saves overlapping replies beside their delayed user transcripts", async () => {
    await suite.withPage(
      {
        permissions: ["microphone"],
        viewport: { width: 1366, height: 900 },
      },
      async ({ page }) => {
        const gateway = await startTalk(page, "voice-ordering-e2e");
        const rows = page.locator(".agent-chat__voice-turn-text");
        const emit = async (event: unknown) => await dispatchOpenAiTalkEvent(page, event);
        const item = async (id: string, role: "user" | "assistant", previous: string | null) =>
          await emit({
            type: "conversation.item.added",
            previous_item_id: previous,
            item: {
              id,
              type: "message",
              role,
              content: role === "user" ? [{ type: "input_audio" }] : [],
            },
          });
        const final = async (id: string, role: "user" | "assistant", transcript: string) =>
          await emit({
            type:
              role === "user"
                ? "conversation.item.input_audio_transcription.completed"
                : "response.output_audio_transcript.done",
            item_id: id,
            transcript,
          });
        await item("answer-2", "assistant", "question-2");
        await emit({
          type: "response.output_audio_transcript.delta",
          item_id: "answer-2",
          delta: "Lantern.",
        });
        await expect.poll(() => rows.allTextContents()).toEqual(["Lantern."]);
        await final("answer-2", "assistant", "Lantern.");
        await emit({
          type: "input_audio_buffer.committed",
          item_id: "question-1",
          previous_item_id: null,
        });
        await item("question-1", "user", null);
        await item("answer-1", "assistant", "question-1");
        await emit({
          type: "response.output_audio_transcript.delta",
          item_id: "answer-1",
          delta: "Glacier.",
        });
        await expect.poll(() => rows.allTextContents()).toEqual(["Glacier.", "Lantern."]);
        await item("question-2", "user", "answer-1");
        await final("question-2", "user", "Please say lantern.");
        await final("answer-1", "assistant", "Glacier.");
        expect(await gateway.getRequests("talk.client.transcript")).toEqual([]);
        await final("question-1", "user", "Please say glacier.");
        await expect
          .poll(() =>
            gateway
              .getRequests("talk.client.transcript")
              .then((requests) => requests.map(({ params }) => params)),
          )
          .toMatchObject([
            { role: "user", text: "Please say glacier." },
            { role: "assistant", text: "Glacier." },
            { role: "user", text: "Please say lantern." },
            { role: "assistant", text: "Lantern." },
          ]);
        await expect
          .poll(() => rows.allTextContents())
          .toEqual(["Please say glacier.", "Glacier.", "Please say lantern.", "Lantern."]);
        await page.getByRole("button", { name: "Stop voice input" }).click();
        await gateway.waitForRequest("talk.client.close");
        expect(await gateway.getRequests("talk.client.close")).toHaveLength(1);
      },
    );
  });

  it("keeps unsaved spoken turns above a message typed after them", async () => {
    await suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1366, height: 900 } },
      async ({ page }) => {
        await startTalk(page, "voice-chronology-e2e");
        const emit = async (event: unknown) => await dispatchOpenAiTalkEvent(page, event);
        await emit({
          type: "input_audio_buffer.committed",
          item_id: "question",
          previous_item_id: null,
        });
        await emit({
          type: "conversation.item.added",
          previous_item_id: null,
          item: {
            id: "question",
            type: "message",
            role: "user",
            content: [{ type: "input_audio" }],
          },
        });
        await emit({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "question",
          transcript: "Spoken question.",
        });
        await emit({
          type: "conversation.item.added",
          previous_item_id: "question",
          item: { id: "answer", type: "message", role: "assistant", content: [] },
        });
        await emit({
          type: "response.output_audio_transcript.delta",
          item_id: "answer",
          delta: "Spoken answer.",
        });
        await emit({
          type: "response.output_audio_transcript.done",
          item_id: "answer",
          transcript: "Spoken answer.",
        });
        await page.getByText("Spoken answer.", { exact: true }).waitFor();
        await composer(page).fill("Typed follow-up.");
        await composer(page).press("Enter");
        const order = () =>
          page
            .locator(".chat-text, .agent-chat__voice-turn-text")
            .allTextContents()
            .then((texts) => texts.map((text) => text.trim()));
        await expect.poll(order).toContain("Typed follow-up.");
        expect(await order()).toEqual([
          "Talk history is ready.",
          "Spoken question.",
          "Spoken answer.",
          "Typed follow-up.",
        ]);
      },
    );
  });
});
