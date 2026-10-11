import { describe, expect, it } from "vitest";
import { resolveComposerMentionHighlights } from "./chat-composer-mention-highlights.ts";

describe("native mention highlights", () => {
  const draft = "Ask @Avery Finch tomorrow";
  const selectedMention = { profileId: "selected-person", start: 4, end: 16 };
  const mentions = [selectedMention];

  it("decorates only validated selected recipients, not typed or pasted names", () => {
    expect(resolveComposerMentionHighlights(draft, draft, mentions)).toEqual(mentions);
    expect(resolveComposerMentionHighlights(draft, draft, [])).toEqual([]);
    expect(
      resolveComposerMentionHighlights(draft, draft, [{ ...selectedMention, end: 90 }]),
    ).toEqual([]);
  });

  it("projects untouched spans through previews without modifying recipient state", () => {
    expect(resolveComposerMentionHighlights("🦞 " + draft, draft, mentions)).toEqual([
      { profileId: "selected-person", start: 7, end: 19 },
    ]);
    expect(resolveComposerMentionHighlights("Ask @Avery Flynn tomorrow", draft, mentions)).toEqual(
      [],
    );
    expect(mentions).toEqual([{ profileId: "selected-person", start: 4, end: 16 }]);
  });
});
