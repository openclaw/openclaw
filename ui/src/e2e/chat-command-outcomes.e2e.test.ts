import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  composer as chatComposer,
  newChatPage,
  persistedText,
  transcript as chatTranscript,
} from "./chat-flow-fixtures.test-support.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { command: "steer", mode: "steer", requested: "Steering requested.", completed: "Steered." },
    {
      command: "redirect",
      mode: "interrupt",
      requested: "Redirect requested.",
      completed: "Redirected.",
    },
  ])(
    "distinguishes /$command acceptance from completion",
    async ({ command, mode, requested, completed }) => {
      const { page } = await newChatPage(suite);
      const runId = "original-run";
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          persistedText("user", "Compare these release notes.", { id: "original-user", seq: 1 }),
        ],
        inFlightRun: { runId, text: "Reviewing the release notes." },
        sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await stop.waitFor();
      const composer = chatComposer(page);
      const message = "Focus only on breaking changes.";
      await gateway.deferNext("chat.send");
      await composer.fill(`/${command} ${message}`);
      await composer.press("Control+Enter");
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ sessionKey, message, queueMode: mode });
      expect(await page.getByText(completed, { exact: true }).count()).toBe(0);
      const requestRunId = requireString(
        requireRecord(sent.params).idempotencyKey,
        "command request identity",
      );
      await gateway.resolveDeferred("chat.send", { runId: requestRunId, status: "started" });
      const notice = page
        .getByText(requested, { exact: true })
        .or(page.getByText(completed, { exact: true }));
      await notice.waitFor();
      await stop.waitFor();
      const root = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (root) {
        const directory = createControlUiE2eArtifactDir(`slash-${command}-outcome`, root);
        const frame = await takeControlUiScreenshotFrame(
          page,
          chatTranscript(page),
          [notice, stop],
          { animations: "disabled" },
        );
        await fs.writeFile(path.join(directory, "acknowledged.png"), frame.png);
      }
      expect(await notice.textContent()).toBe(requested);
      expect(await composer.inputValue()).toBe("");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
    },
  );
});
