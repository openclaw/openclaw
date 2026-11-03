import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { chatFixture, timedText, transcript } from "./chat-flow-fixtures.test-support.ts";
import { captureUiProofEnabled, createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const prompt =
  "[cron:review-watch Continue review] Check the pull request and continue the authorized work. " +
  "Keep the accepted merge request intact. Verify the current head and report only the result.\n\n" +
  "This is an unattended scheduled run. Nobody is present to clarify or approve. " +
  "Your final reply is the deliverable, not a plan or acknowledgment. " +
  "If nothing needs doing, reply with exactly NO_REPLY as the entire final answer.";

suite.define(() => {
  it("collapses recorded automation prompts without hiding results or lookalike user text", async () => {
    const { page } = await chatFixture(
      suite,
      {
        historyMessages: [
          timedText("user", "Please review the change and open a pull request."),
          timedText("assistant", "The fix is ready. I am checking the pull request."),
          timedText("user", prompt, {
            provenance: { kind: "internal_system", sourceTool: "cron" },
          }),
          timedText("assistant", "The pull request is ready for review."),
          timedText("user", "Explain this literal text: [cron:example This is not an automation]"),
        ],
      },
      { viewport: { width: 390, height: 844 }, colorScheme: "light" },
    );
    await page.goto(suite.server.baseUrl + "chat");
    const thread = transcript(page);
    await thread.getByText("The pull request is ready for review.", { exact: true }).waitFor();
    if (captureUiProofEnabled) {
      const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [thread], {
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "automation-prompt.png"), frame.png);
    }
    const disclosure = thread.locator("details", { hasText: "Automation" });
    await expect.poll(() => disclosure.count()).toBe(1);
    expect(await disclosure.getAttribute("open")).toBeNull();
    expect(await thread.getByText(prompt, { exact: true }).isVisible()).toBe(false);
    expect(
      await thread
        .getByText("Explain this literal text: [cron:example This is not an automation]", {
          exact: true,
        })
        .isVisible(),
    ).toBe(true);
    await disclosure.locator("summary").click();
    await thread.getByText(prompt, { exact: true }).waitFor();
    await disclosure.locator("summary").click();
    await expect.poll(() => thread.getByText(prompt, { exact: true }).isVisible()).toBe(false);
    await page.reload();
    await thread.getByText("The pull request is ready for review.", { exact: true }).waitFor();
    expect(await disclosure.getAttribute("open")).toBeNull();
  });
});
