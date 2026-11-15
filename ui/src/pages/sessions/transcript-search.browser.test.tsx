import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { TranscriptSearchForm } from "./transcript-search-view.tsx";

it("preserves the focused transcript query when Escape cancels IME composition", async () => {
  const onSearch = vi.fn();
  const view = mountSolid(() => (
    <TranscriptSearchForm
      transcriptSearchAvailable={true}
      transcriptSearchQuery="launch query"
      transcriptSearch={null}
      onTranscriptSearchChange={vi.fn()}
      onTranscriptSearch={onSearch}
      onClearTranscriptSearch={vi.fn()}
      onNavigateToChat={vi.fn()}
    />
  ));
  try {
    await page.getByRole("button", { name: "Search transcripts", exact: true }).click();
    const input = page.getByRole("searchbox", { name: "Search session transcripts" });
    const element = input.element();
    await waitForSolid(() => expect(document.activeElement).toBe(element));
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(escape);
    await waitForSolid(() => {
      expect(element.isConnected).toBe(true);
      expect(document.activeElement).toBe(element);
    });
    expect(escape.defaultPrevented).toBe(false);
    expect(onSearch).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    cleanupSolid();
  }
});
