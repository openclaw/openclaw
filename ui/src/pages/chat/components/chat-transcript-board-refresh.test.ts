/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyBoardSnapshot } from "../../../lib/board/provider-helpers.ts";
import { ValueSignal } from "../../../lib/board/provider-signals.ts";
import { boardProviderForSession } from "../../../lib/board/provider.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import * as messageFrame from "./chat-message-group-frame.ts";
import { transcriptContainer } from "./chat-transcript-fixture.test-support.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("keeps settled transcript rows idle when the dashboard snapshot changes", async () => {
  const sessionKey = "agent:main:dashboard:row-refresh";
  const snapshot = new ValueSignal(emptyBoardSnapshot(sessionKey));
  const props = {
    ...threadProps("dashboard-row-refresh", sessionKey, [
      { role: "user", content: "Check the release", timestamp: 1_000 },
      { role: "assistant", content: "The release is ready.", timestamp: 2_000 },
    ]),
    boardProvider: {
      ...boardProviderForSession({ sessionKey }, false),
      snapshot$: snapshot,
    },
  };
  const transcript = createTestTranscript();
  const container = transcriptContainer();
  const rerender = () => render(renderChatThread({ ...props }, transcript), container);
  const prepare = vi.spyOn(messageFrame, "prepareMessageGroupFrame");
  try {
    rerender();
    transcript.start();
    transcript.update();
    await flushDeferredRowPrune();
    const rows = [...container.querySelectorAll(".chat-virtual-row")];
    expect(rows).toHaveLength(2);
    expect(prepare).toHaveBeenCalled();
    prepare.mockClear();

    snapshot.set({ ...snapshot.value, revision: snapshot.value.revision + 1 });
    rerender();
    transcript.update();
    await flushDeferredRowPrune();

    expect(container.textContent).toContain("The release is ready.");
    const retainedRows = [...container.querySelectorAll(".chat-virtual-row")];
    expect(retainedRows).toHaveLength(rows.length);
    retainedRows.forEach((row, index) => expect(row).toBe(rows[index]));
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    render(null, container);
    transcript.dispose();
    container.remove();
  }
});
