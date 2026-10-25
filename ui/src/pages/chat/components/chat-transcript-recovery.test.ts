/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { resetChatViewState } from "../chat-view-state.test-support.ts";
import { renderChatThread, TranscriptTestHost } from "../test-helpers/chat-transcript-native.tsx";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import { toggleTranscriptSearch, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

type FullMessageResult = Awaited<ReturnType<SidebarFullMessageLoader>>;

const previewMessage = {
  role: "assistant",
  content: "Preview\n...(truncated)...",
  __openclaw: { id: "assistant-full-1", truncated: true },
  timestamp: 1_000,
};

function fullMessage(content: string): FullMessageResult {
  return { ok: true, message: { role: "assistant", content } };
}
const resolvedLoader = (body: string) =>
  vi.fn<SidebarFullMessageLoader>().mockResolvedValue(fullMessage(body));
const bubble = (pane: RecoveryTranscriptElement) => pane.querySelector(".chat-bubble");
const shows = (pane: RecoveryTranscriptElement, text: string) =>
  vi.waitFor(() => expect(pane.textContent).toContain(text));
async function render(pane: RecoveryTranscriptElement, patch: Partial<ChatThreadProps> = {}) {
  Object.assign(pane.props, patch);
  pane.requestRender();
  await pane.updateComplete;
}

class RecoveryTranscriptElement extends TranscriptTestHost {
  props: ChatThreadProps = threadProps("recovery-pane");
  resetPresentationOnDisconnect = true;
  override readonly transcript = createChatTranscript(() => this.props.paneId);

  override renderTranscript = () => renderChatThread(this.props, this.transcript, { search: true });

  override disconnectedCallback() {
    // Match the pane-specific production reset before disposing the transcript.
    if (this.resetPresentationOnDisconnect) {
      resetChatViewState(this.props.paneId);
    }
    super.disconnectedCallback();
  }
}

customElements.define("test-recovery-transcript", RecoveryTranscriptElement);

function mountTranscript(
  paneId: string,
  loadFullAssistantMessage: SidebarFullMessageLoader,
  sessionKey = "agent:work:main",
): RecoveryTranscriptElement {
  const pane = document.createElement("test-recovery-transcript") as RecoveryTranscriptElement;
  pane.props = {
    ...threadProps(paneId, sessionKey, [previewMessage]),
    fullMessageAgentId: "work",
    loadFullAssistantMessage,
  };
  document.body.append(pane);
  return pane;
}

async function searchTranscript(pane: RecoveryTranscriptElement, query: string) {
  if (!pane.querySelector(".agent-chat__search-bar input")) {
    toggleTranscriptSearch(pane.props.paneId);
    await pane.settleUpdates();
  }
  const input = expectDefined(
    pane.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
    "transcript search input",
  );
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pane.settleUpdates();
}

describe("chat transcript full-message recovery", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("updates an unchanged search when a hidden reply finishes recovering", async () => {
    const pending = createDeferred<FullMessageResult>();
    const load = vi.fn<SidebarFullMessageLoader>().mockImplementation(() => pending.promise);
    const pane = mountTranscript("recovery-active-search", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await searchTranscript(pane, "lunarneedle");
    expect(bubble(pane)).toBeNull();

    pending.resolve(fullMessage("The restored exhibit is lunarneedle."));
    await vi.waitFor(() => expect(bubble(pane)?.textContent).toContain("lunarneedle"));
    expect(load).toHaveBeenCalledOnce();
  });

  it("recovers an oversized source group with its tool cards and complete output", async () => {
    const output = "x".repeat(5_000_000) + " OUTPUT_END";
    const load = vi.fn<SidebarFullMessageLoader>().mockImplementation(async ({ maxChars }) => ({
      ok: true,
      message: {
        role: "assistant",
        __openclaw: { id: "oversized-tools" },
        content: [
          { type: "toolCall", id: "large-result", name: "exec", arguments: { command: "check" } },
          {
            type: "toolResult",
            id: "large-result",
            name: "exec",
            text: output.slice(0, maxChars ?? 500_000),
          },
        ],
      },
    }));
    const pane = mountTranscript("recovery-oversized-tools", load);
    pane.props = {
      ...pane.props,
      showToolCalls: true,
      messages: [
        {
          role: "assistant",
          content: "[chat.history omitted: message too large]",
          __openclaw: { id: "oversized-tools", truncated: true, reason: "oversized" },
        },
      ],
    };
    await pane.updateComplete;
    await expectDefined(load.mock.results[0]?.value, "full-message load");
    await pane.updateComplete;
    expect(load).toHaveBeenCalledExactlyOnceWith({
      sessionKey: "agent:work:main",
      agentId: "work",
      messageId: "oversized-tools",
      maxChars: 8_000_000,
    });
    const disclosure = await waitForSolid(() =>
      expectDefined(
        pane.querySelector<HTMLButtonElement>(".chat-tool-msg-summary:enabled"),
        "recovered tool disclosure",
      ),
    );
    disclosure.click();
    await waitForSolid(() =>
      expect(pane.querySelector(".chat-tool-term__out")?.textContent).toBe(output),
    );
    expect(pane.textContent).not.toContain("This message is too large to display here.");
    expect(pane.textContent).not.toContain("Could not load the full message.");
  });

  it("keeps the preview through bounded retries and recovers on manual retry", async () => {
    const load = vi.fn<SidebarFullMessageLoader>().mockRejectedValue(new Error("offline"));
    const pane = mountTranscript("recovery-unavailable", load);
    await shows(pane, "Could not load the full message.");
    expect(load).toHaveBeenCalledTimes(3);
    expect(pane.textContent).toContain("Preview");
    expect(pane.textContent).toContain("...(truncated)...");
    expect(pane.querySelector(".chat-message-disclosure__toggle")).toBeNull();

    load.mockResolvedValue(fullMessage("Available after retry."));
    expectDefined(
      pane.querySelector<HTMLButtonElement>(".chat-message-load-error__retry"),
      "full-message retry",
    ).click();
    await shows(pane, "Available after retry.");
    expect(load).toHaveBeenCalledTimes(4);
  });

  it.each([
    { phase: "loading", retirement: "reconnect" },
    { phase: "loaded", retirement: "reconnect" },
    { phase: "loading", retirement: "remount" },
    { phase: "loading", retirement: "prune" },
  ])("retires $phase recovery on $retirement", async ({ phase, retirement }) => {
    const retired = createDeferred<FullMessageResult>();
    const current = createDeferred<FullMessageResult>();
    const load = vi
      .fn<SidebarFullMessageLoader>()
      .mockImplementationOnce(() => retired.promise)
      .mockImplementationOnce(() => current.promise);
    let pane = mountTranscript("recovery-reconnect", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    if (phase === "loaded") {
      retired.resolve(fullMessage("Retired body."));
      await shows(pane, "Retired body.");
    }

    const oldPane = pane;
    if (retirement === "prune") {
      await render(pane, { messages: [] });
      await render(pane, { messages: [previewMessage] });
    } else {
      // Reconnect retains presentation; remount also exercises the pane reset.
      pane.resetPresentationOnDisconnect = retirement === "remount";
      pane.remove();
      if (retirement === "reconnect") {
        document.body.append(pane);
      } else {
        pane = mountTranscript("recovery-reconnect", load);
      }
      await render(pane);
    }
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await flushDeferredRowPrune();
    expect(pane.textContent).not.toContain("Retired body.");

    if (retirement === "remount") {
      current.resolve(fullMessage("Current body."));
      await shows(pane, "Current body.");
    }

    if (phase === "loading") {
      const updates = vi.spyOn(oldPane, "requestRender");
      retired.resolve(fullMessage("Retired body."));
      await flushDeferredRowPrune();
      expect(updates).not.toHaveBeenCalled();
      expect(pane.textContent).not.toContain("Retired body.");
    }

    current.resolve(fullMessage("Current body."));
    await shows(pane, "Current body.");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retires a disconnected pane's bodies without invalidating a surviving split pane", async () => {
    const load = resolvedLoader("Original answer.");
    const first = mountTranscript("recovery-split-first", load);
    await shows(first, "Original answer.");
    const sibling = mountTranscript("recovery-split-second", load);
    await shows(sibling, "Original answer.");
    const loadedRequests = load.mock.calls.length;

    first.remove();
    await render(sibling);
    expect(sibling.textContent).toContain("Original answer.");
    expect(load).toHaveBeenCalledTimes(loadedRequests);

    load.mockResolvedValue(fullMessage("Recovered after remount."));
    const replacement = mountTranscript("recovery-split-first", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(loadedRequests + 1));
    await shows(replacement, "Recovered after remount.");
    expect(sibling.textContent).toContain("Original answer.");
  });

  it.each(["session", "agent"] as const)("scopes recovery to the requested %s", async (scope) => {
    const load = resolvedLoader("First scope.");
    const pane = mountTranscript("recovery-routing", load, "global");
    await shows(pane, "First scope.");
    await searchTranscript(pane, "First scope");
    expect(bubble(pane)?.textContent).toContain("First scope.");

    load.mockResolvedValue(fullMessage("Second scope."));
    await render(
      pane,
      scope === "session" ? { sessionKey: "agent:work:other" } : { fullMessageAgentId: "other" },
    );
    expect(bubble(pane)).toBeNull();
    toggleTranscriptSearch(pane.props.paneId);
    await shows(pane, "Second scope.");
    expect(load).toHaveBeenLastCalledWith({
      sessionKey: pane.props.sessionKey,
      agentId: pane.props.fullMessageAgentId,
      messageId: "assistant-full-1",
    });
    await searchTranscript(pane, "First scope");
    expect(bubble(pane)).toBeNull();
    await searchTranscript(pane, "Second scope");
    expect(bubble(pane)?.textContent).toContain("Second scope.");
  });

  it("keeps recovered pending-input text until that input leaves the source", async () => {
    const load = resolvedLoader("Accepted input.");
    const pane = mountTranscript("recovery-pending-input", load);
    const pendingInputs: ChatThreadProps["pendingInputs"] = [
      {
        id: "accepted-1",
        acceptedAt: 1_000,
        state: "queued",
        message: {
          ...previewMessage,
          role: "user",
          __openclaw: { id: "pending:accepted-1", truncated: true },
        },
      },
    ];
    pane.props.messages = [];
    pane.props.pendingInputs = pendingInputs;
    await shows(pane, "Accepted input.");
    await render(pane);
    expect(load).toHaveBeenCalledOnce();
    expect(pane.textContent).toContain("Accepted input.");
    await searchTranscript(pane, "Accepted input");
    expect(bubble(pane)?.textContent).toContain("Accepted input.");

    await render(pane, { pendingInputs: [] });
    load.mockResolvedValue(fullMessage("Revisited input."));
    await render(pane, { pendingInputs });
    expect(bubble(pane)).toBeNull();
    toggleTranscriptSearch(pane.props.paneId);
    await shows(pane, "Revisited input.");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stops searching recovered text when the source is no longer capped", async () => {
    const load = resolvedLoader("Recovered body.");
    const pane = mountTranscript("recovery-replaced-source", load);
    await shows(pane, "Recovered body.");
    await searchTranscript(pane, "Recovered body");
    expect(bubble(pane)?.textContent).toContain("Recovered body.");

    await render(pane, {
      messages: [
        {
          ...previewMessage,
          content: "Current source body.",
          __openclaw: { id: "assistant-full-1" },
        },
      ],
    });
    expect(bubble(pane)).toBeNull();
    await searchTranscript(pane, "Current source body");
    expect(bubble(pane)?.textContent).toContain("Current source body.");
    expect(load).toHaveBeenCalledOnce();
  });
});
