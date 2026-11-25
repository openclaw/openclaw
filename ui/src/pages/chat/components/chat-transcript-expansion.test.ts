/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
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

const runId = "activity-run";

/** A live tool stream receipt; `settle` publishes its result and returns the new message. */
function liveTool(toolCallId: string, name: string, args: unknown, at: number) {
  const started = { phase: "start" as const, name, toolCallId, args };
  const activity = [projectAgentToolActivity(started)];
  const times = { startedAt: at, receivedAt: at };
  const entry: ToolStreamEntry = { runId, toolCallId, name, args, ...times, message: {}, activity };
  refreshToolStreamMessage(entry);
  const settle = () => {
    entry.output = "Operation returned";
    entry.resultReceived = true;
    entry.activity = [projectAgentToolActivity({ ...started, phase: "result", isError: false })];
    refreshToolStreamMessage(entry);
    return entry.message;
  };
  return { message: entry.message, settle };
}

const storedCall = (id: string, name: string, args: unknown, seq: number) => ({
  role: "assistant",
  runId,
  timestamp: seq * 1_000,
  __openclaw: { id: `stored-${id}`, seq, runId },
  content: [{ type: "toolCall", id, name, arguments: args }],
});

function mountThread(id: string, messages: unknown[]) {
  const prompt = {
    role: "user",
    content: "Inspect sources",
    timestamp: 1_000,
    __openclaw: { id: "request", seq: 1, idempotencyKey: runId },
  };
  const run = { runId, runActive: true, runWorking: true, showToolCalls: true };
  const props = threadProps(id, `agent:main:dashboard:${id}`, [prompt, ...messages], run);
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    render(null, container);
    transcript.dispose();
  });
  return {
    prompt,
    props,
    container,
    draw: async () => {
      render(renderChatThread({ ...props }, transcript), container);
      await settleToolBridges(container);
    },
    summaries: () => [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-activity-group__summary"),
    ],
  };
}

describe("transcript expansion", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps the first activity disclosure through hydration and append", async () => {
    const args = { code: "return await read({path: 'first.ts'});", title: "Inspect source" };
    const call = storedCall("first-call", "exec", args, 2);
    const { prompt, props, container, draw, summaries } = mountThread("first-call", [call]);
    await draw();
    const summary = await waitForSolid(() => expectDefined(summaries()[0], "first disclosure"));
    summary.click();
    await waitForSolid(() => expect(summary.getAttribute("aria-expanded")).toBe("true"));
    const expectRetained = () => {
      expect(summaries()[0]).toBe(summary);
      expect(summary.getAttribute("aria-expanded")).toBe("true");
    };

    // The live receipt for the stored call hydrates into the same open disclosure.
    const live = liveTool("first-call", "exec", args, 2_000);
    props.toolMessages = [live.message];
    await draw();
    expectRetained();

    props.toolMessages = [live.settle()];
    const next = storedCall("second-call", "read", { path: "second.ts" }, 3);
    props.messages = [prompt, call, next];
    await draw();
    expect(summaries()).toHaveLength(1);
    expectRetained();
    expect(container.querySelector(".chat-tool-row--running")).toBeNull();

    const commentary = { role: "assistant", runId, phase: "commentary", timestamp: 4_000 };
    props.messages = [
      ...props.messages,
      { ...commentary, content: "A separate next step." },
      storedCall("third-call", "read", { path: "third.ts" }, 5),
    ];
    await draw();
    await waitForSolid(() => expect(summaries()).toHaveLength(2));
    expectRetained();
  });

  it("keeps a later activity segment open through a history gap", async () => {
    const history = [
      { role: "toolResult", toolCallId: "older", toolName: "read", content: "Earlier" },
    ];
    const calls = ["first", "second", "launch", "third", "fourth"].map((id) => ({
      id,
      name: id === "launch" ? "sessions_spawn" : "read",
      args: id === "launch" ? { label: "Helper", task: "Read only" } : { path: `${id}.ts` },
    }));
    const { prompt, props, draw, summaries } = mountThread("segmented", []);
    props.messages = [...history, prompt];
    props.toolMessages = calls.map(
      ({ id, name, args }, index) => liveTool(id, name, args, 2_000 + index).message,
    );
    await draw();
    await waitForSolid(() => expect(summaries()).toHaveLength(2));
    summaries()[1]!.click();
    await waitForSolid(() => expect(summaries()[1]!.getAttribute("aria-expanded")).toBe("true"));
    props.toolMessages = [];
    props.runActive = false;
    props.runWorking = false;
    await draw();
    props.messages = [
      ...history,
      prompt,
      ...calls.map(({ id, name, args }, index) => storedCall(id, name, args, index + 2)),
    ];
    await draw();
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(summaries()[0]!.getAttribute("aria-expanded")).toBe("false");
  });

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
