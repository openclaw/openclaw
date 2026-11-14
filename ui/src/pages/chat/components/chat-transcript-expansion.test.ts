import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
/* @vitest-environment jsdom */
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import type { ToolStreamEntry } from "../tool-stream-contract.ts";
import { refreshToolStreamMessage } from "../tool-stream-state.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

describe("transcript expansion", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each([false, true])(
    "keeps the first activity disclosure through hydration and append (bubbles=%s)",
    async (chatBubbleMode) => {
      const runId = "first-call-run";
      const args = { code: "return await read({path: 'first.ts'});", title: "Inspect source" };
      const call = {
        role: "assistant",
        runId,
        timestamp: 2_000,
        __openclaw: { id: "first-message", seq: 2, runId },
        content: [{ type: "toolCall", id: "first-call", name: "exec", arguments: args }],
      };
      const prompt = {
        role: "user",
        content: "Inspect sources",
        timestamp: 1_000,
        __openclaw: { id: "request", seq: 1, idempotencyKey: runId },
      };
      const props = threadProps("first-call", "agent:main:dashboard:first-call", [prompt, call], {
        showToolCalls: true,
        runId,
        runActive: true,
        runWorking: true,
        chatBubbleMode,
      });
      const transcript = createTestTranscript(props.paneId);
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => {
        render(null, container);
        transcript.dispose();
      });
      const draw = () => render(renderChatThread({ ...props }, transcript), container);
      const summaries = () => [
        ...container.querySelectorAll<HTMLButtonElement>(".chat-activity-group__summary"),
      ];
      draw();
      const summary = await waitForSolid(() =>
        expectDefined(summaries()[0], "first activity disclosure"),
      );
      const controls = expectDefined(
        summary.getAttribute("aria-controls"),
        "activity body identity",
      );
      const row = expectDefined(summary.closest(".chat-virtual-row"), "owning transcript row");
      summary.click();
      await waitForSolid(() => expect(summary.getAttribute("aria-expanded")).toBe("true"));

      const started = { phase: "start" as const, name: "exec", toolCallId: "first-call", args };
      const live: ToolStreamEntry = {
        runId,
        toolCallId: "first-call",
        name: "exec",
        args,
        startedAt: 2_000,
        receivedAt: 2_000,
        message: {},
        activity: [projectAgentToolActivity(started)],
      };
      refreshToolStreamMessage(live);
      props.toolMessages = [live.message];
      draw();
      await settleToolBridges(container);
      expect(summaries()[0]).toBe(summary);
      expect(summary.getAttribute("aria-controls")).toBe(controls);
      expect(summary.getAttribute("aria-expanded")).toBe("true");
      expect(summary.closest(".chat-virtual-row")).toBe(row);

      live.output = "First operation returned";
      live.resultReceived = true;
      live.activity = [projectAgentToolActivity({ ...started, phase: "result", isError: false })];
      refreshToolStreamMessage(live);
      const next = {
        role: "assistant",
        runId,
        timestamp: 3_000,
        __openclaw: { id: "second-message", seq: 3, runId },
        content: [
          { type: "toolCall", id: "second-call", name: "read", arguments: { path: "second.ts" } },
        ],
      };
      props.messages = [prompt, call, next];
      props.toolMessages = [live.message];
      draw();
      await settleToolBridges(container);
      expect(summaries()).toHaveLength(1);
      expect(summaries()[0]).toBe(summary);
      expect(summary.getAttribute("aria-expanded")).toBe("true");
      expect(summary.closest(".chat-virtual-row")).toBe(row);
      expect(container.querySelector(".chat-tool-row--running")).toBeNull();

      props.messages = [
        ...props.messages,
        {
          role: "assistant",
          runId,
          phase: "commentary",
          content: "A separate next step.",
          timestamp: 4_000,
        },
        {
          ...next,
          timestamp: 5_000,
          __openclaw: { id: "third-message", seq: 5, runId },
          content: [
            { type: "toolCall", id: "third-call", name: "read", arguments: { path: "third.ts" } },
          ],
        },
      ];
      draw();
      await waitForSolid(() => expect(summaries()).toHaveLength(2));
      expect(summaries()[0]).toBe(summary);
      expect(summary.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("A separate next step.");
    },
  );

  it("shares explicit disclosures across panes with different loaded history", async () => {
    const messages = [
      { role: "user", content: "Check the older result.", timestamp: 1 },
      { role: "assistant", content: "Older check completed.", timestamp: 3 },
      { role: "user", content: "Check the recent result.", timestamp: 4 },
      {
        role: "toolResult",
        toolCallId: "recent",
        toolName: "read",
        content: "Recent result",
        timestamp: 5,
      },
    ];
    const sessionKey = "split-history-disclosure-ui";
    const full = { ...threadProps("split-full", sessionKey, messages), showToolCalls: true };
    const partial = {
      ...threadProps("split-partial", sessionKey, messages.slice(2)),
      showToolCalls: true,
    };
    const fullTranscript = createTestTranscript(full.paneId);
    const partialTranscript = createTestTranscript(partial.paneId);
    const fullPane = document.body.appendChild(document.createElement("div"));
    const partialPane = document.body.appendChild(document.createElement("div"));
    const disclosures = (pane: HTMLElement) =>
      Array.from(pane.querySelectorAll<HTMLButtonElement>(".chat-tool-msg-summary:enabled")).filter(
        (button) => !button.closest(".chat-tool-msg-body"),
      );
    onTestFinished(() => {
      render(null, fullPane);
      render(null, partialPane);
      fullTranscript.dispose();
      partialTranscript.dispose();
    });
    render(renderChatThread(full, fullTranscript), fullPane);
    await settleToolBridges(fullPane);
    (
      await waitForSolid(() => expectDefined(disclosures(fullPane)[0], "shared tool disclosure"))
    ).click();
    await waitForSolid(() =>
      expect(disclosures(fullPane)[0]?.getAttribute("aria-expanded")).toBe("true"),
    );

    render(renderChatThread(partial, partialTranscript), partialPane);
    await settleToolBridges(partialPane);
    await waitForSolid(() =>
      expect(disclosures(partialPane)[0]?.getAttribute("aria-expanded")).toBe("true"),
    );
    expectDefined(disclosures(partialPane)[0], "shared tool disclosure in sibling pane").click();
    await waitForSolid(() =>
      expect(disclosures(fullPane)[0]?.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});
