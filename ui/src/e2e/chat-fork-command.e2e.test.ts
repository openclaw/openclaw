import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { chatFixture, composer, textMessage } from "./chat-flow-fixtures.test-support.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([false, true])("forks through typed and menu paths (active=%s)", async (active) => {
    const key = "agent:main:fork-source";
    const { page, gateway } = await chatFixture(suite, {
      sessionKey: key,
      sessions: [
        {
          ...createControlUiSessionRow(key, "Synthetic fork source", 1_000),
          hasActiveRun: active,
          sharingRole: "owner",
        },
      ],
      historyMessages: [
        textMessage("user", "Compare two synthetic release plans."),
        textMessage("assistant", "Plan A is ready for review."),
      ],
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
    const input = composer(page);
    await input.fill("/fo");
    const suggestion = page.getByRole("option", { name: /^Fork session\b/ });
    await suggestion.waitFor();
    const frame = await takeControlUiScreenshotFrame(page, input, [input, suggestion], {
      animations: "disabled",
    });
    await writeFile(path.join(suite.artifactDir, `fork-suggestion-${active}.png`), frame.png);
    await input.fill("/fork Release plan");
    await input.press("Enter");
    const request = await gateway.waitForRequest("sessions.create");
    expect(requireRecord(request.params)).toMatchObject({
      parentSessionKey: key,
      fork: true,
      label: "Release plan",
      ...(active ? { forkFrom: "last-completed" } : {}),
    });
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await expect.poll(() => page.url()).not.toBe(controlUiSessionUrl(suite.server.baseUrl, key));
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
    await input.fill("Keep my unsent draft");
    await page
      .locator("openclaw-chat-header-session-menu")
      .getByRole("button", { name: "Actions for Synthetic fork source", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Advanced", exact: true }).click();
    await page.getByRole("menuitem", { name: "Fork session", exact: true }).click();
    await expect.poll(() => gateway.getRequests("sessions.create")).toHaveLength(1);
    const button = requireRecord((await gateway.getRequests("sessions.create"))[0]!.params);
    expect(button).toEqual({
      parentSessionKey: key,
      fork: true,
      agentId: "main",
      ...(active ? { forkFrom: "last-completed" } : {}),
    });
    expect(await gateway.getRequests("sessions.fork")).toHaveLength(0);
    await expect.poll(() => page.url()).not.toBe(controlUiSessionUrl(suite.server.baseUrl, key));
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
    await expect.poll(() => input.inputValue()).toBe("Keep my unsent draft");
  });
});
