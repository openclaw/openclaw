import { expect, it } from "vitest";
import { configResponse } from "./appearance-prefs.test-support.ts";
import {
  chatMessage,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps the sign-in action with the reply when tool calls are hidden", async () => {
    const page = await newChatPage(suite);
    const runId = "fieldnotes-run";
    const answer = "The checklist needs a new sign-in.";
    const destination = "https://accounts.fieldnotes.example/sign-in";
    const timestamp = Date.now() - 5_000;
    await page.context().route(destination, (route) => route.fulfill({ body: "Sign-in page" }));
    await installMockGateway(page, {
      historyMessages: [
        chatMessage("user", "Check the launch checklist.", {
          timestamp,
          __openclaw: { id: "prompt", seq: 1, idempotencyKey: `${runId}:user` },
        }),
        chatMessage("toolResult", "Sign-in required.", {
          timestamp: timestamp + 1_000,
          toolName: "fieldnotes__list_items",
          toolCallId: "checklist",
          isError: true,
          details: { mcpConnect: { serverName: "Fieldnotes", authorizationUrl: destination } },
          __openclaw: { id: "tool", seq: 2, runId },
        }),
        chatMessage("assistant", answer, {
          timestamp: timestamp + 2_000,
          stopReason: "stop",
          __openclaw: { id: "answer", seq: 3, runId },
        }),
      ],
      methodResponses: {
        "config.get": configResponse({ chatShowToolCalls: false }, "hidden-tool-calls"),
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const reply = page.getByText(answer, { exact: true });
    await reply.waitFor();
    const card = page.getByRole("region", { name: "Sign in to Fieldnotes" });
    const signIn = card.getByRole("link", { name: "Sign in", exact: true });
    await signIn.waitFor();
    const toolOutput = page.getByRole("button", {
      name: "Tool output fieldnotes__list_items",
      exact: true,
    });
    expect(await toolOutput.count()).toBe(0);
    expect((await card.boundingBox())!.y).toBeGreaterThan((await reply.boundingBox())!.y);
    const opening = page.context().waitForEvent("page");
    await signIn.press("Enter");
    const popup = await opening;
    await popup.waitForURL(destination);
  });
});
