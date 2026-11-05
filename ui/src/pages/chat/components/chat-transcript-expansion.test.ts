/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

describe("transcript expansion", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

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
      Array.from(pane.querySelectorAll<HTMLButtonElement>(".chat-tool-msg-summary")).filter(
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
    expectDefined(disclosures(fullPane)[0], "shared tool disclosure").click();
    await waitForSolid(() =>
      expect(disclosures(fullPane)[0]?.getAttribute("aria-expanded")).toBe("true"),
    );

    render(renderChatThread(partial, partialTranscript), partialPane);
    await settleToolBridges(partialPane);
    expect(disclosures(partialPane)[0]?.getAttribute("aria-expanded")).toBe("true");
    expectDefined(disclosures(partialPane)[0], "shared tool disclosure in sibling pane").click();
    await waitForSolid(() =>
      expect(disclosures(fullPane)[0]?.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});
