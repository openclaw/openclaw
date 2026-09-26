import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("marks interrupted replies from history after a reload", async () => {
    await suite.withPage(
      { viewport: { height: 800, width: 1200 } },
      async ({ page: currentPage }) => {
        await installMockGateway(currentPage, {
          historyMessages: [
            { role: "assistant", content: "A completed reply.", stopReason: "stop" },
            { role: "user", content: "Tell me about the history of civilization." },
            {
              role: "assistant",
              content: [{ type: "text", text: "From the earliest river" }],
              stopReason: "stop",
              openclawAbort: { aborted: true, origin: "rpc", runId: "stopped-run" },
            },
          ],
        });
        await currentPage.goto(`${suite.server.baseUrl}chat`);
        await currentPage
          .locator(".chat-text")
          .getByText("From the earliest river", { exact: true })
          .waitFor();
        await currentPage.reload();
        const partial = currentPage.locator(".chat-bubble", { hasText: "From the earliest river" });
        await partial.waitFor({ state: "visible" });
        await captureUiProof(suite, currentPage, "interrupted-replies", "stopped-reloaded.png");
        await partial.getByRole("status").getByText("Interrupted", { exact: true }).waitFor();
        expect(
          await currentPage
            .locator(".chat-bubble [role=status]", { hasText: "Interrupted" })
            .count(),
        ).toBe(1);
        expect(
          await currentPage
            .locator(".chat-bubble", { hasText: "A completed reply." })
            .getByRole("status")
            .count(),
        ).toBe(0);
      },
    );
  });
});
