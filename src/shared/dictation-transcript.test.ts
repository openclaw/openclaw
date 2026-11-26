import { describe, expect, it } from "vitest";
import { DictationSnippetIndex, initialSnippetIntents } from "./dictation-snippets.js";
import { DictationTranscriptSegments } from "./dictation-transcript.js";
import { createVoiceSnippetCatalog, editVoiceSnippetCatalog } from "./voice-snippets.js";

describe("canonical dictation receipts", () => {
  it("revises one stable segment once, ignores old finals, and expands only its latest text", () => {
    const transcript = new DictationTranscriptSegments();
    transcript.record({
      id: "turn-1",
      position: 1,
      revision: 1,
      text: "insert snippet old",
      final: false,
    });
    transcript.record({
      id: "turn-1",
      position: 2,
      revision: 2,
      text: "insert snippet reply",
      final: true,
    });
    expect(
      transcript.record({
        id: "turn-1",
        position: 2,
        revision: 2,
        text: "insert snippet reply",
        final: true,
      }),
    ).toBe(false);
    expect(
      transcript.record({
        id: "turn-1",
        position: 1,
        revision: 1,
        text: "insert snippet old",
        final: true,
      }),
    ).toBe(false);
    expect(
      transcript.record({
        id: "turn-1",
        position: 3,
        revision: 3,
        text: "partial after final",
        final: false,
      }),
    ).toBe(false);
    const result = transcript.snapshot();
    expect(result).toEqual({
      text: "insert snippet reply",
      revision: 2,
      finalized: true,
      qualified: true,
    });
    let catalog = editVoiceSnippetCatalog(createVoiceSnippetCatalog(), {
      type: "enabled",
      enabled: true,
    });
    catalog = editVoiceSnippetCatalog(catalog, {
      type: "save",
      expectedRevision: null,
      snippet: {
        id: "reply",
        name: "Reply",
        locale: "en",
        triggers: ["reply"],
        body: "001 {{name}}\n\n<date>",
        enabled: true,
        sensitivity: "normal",
      },
    });
    const request = {
      schemaVersion: 1 as const,
      captureId: "capture",
      generation: 1,
      transcriptRevision: result.revision,
      mode: "dictation" as const,
      rawTranscript: result.text,
    };
    const resolved = new DictationSnippetIndex(catalog).resolve(
      request,
      initialSnippetIntents(request),
      catalog,
    );
    expect(resolved.problems).toEqual([]);
    expect(resolved.candidates.map((candidate) => candidate.text)).toEqual([
      "001 {{name}}\n\n<date>",
    ]);
  });

  it("orders out-of-order final receipts by source position and requires all segments finalized", () => {
    const transcript = new DictationTranscriptSegments();
    transcript.record({ id: "later", position: 20, revision: 20, text: "Second", final: true });
    transcript.record({ id: "earlier", position: 10, revision: 10, text: "First", final: false });
    expect(transcript.snapshot()).toMatchObject({ text: "First Second", finalized: false });
    transcript.record({
      id: "earlier",
      position: 25,
      revision: 25,
      text: "Revised first",
      final: true,
    });
    expect(transcript.snapshot()).toEqual({
      text: "Revised first Second",
      revision: 25,
      finalized: true,
      qualified: true,
    });
  });

  it("disqualifies missing receipts and bounded overflow instead of automatically invoking", () => {
    const transcript = new DictationTranscriptSegments();
    for (let index = 0; index < 128; index++) {
      expect(
        transcript.record({
          id: `segment-${index}`,
          position: index,
          revision: index,
          text: "word",
          final: true,
        }),
      ).toBe(true);
    }
    expect(
      transcript.record({
        id: "overflow",
        position: 128,
        revision: 128,
        text: "insert snippet reply",
        final: true,
      }),
    ).toBe(false);
    expect(transcript.snapshot().qualified).toBe(false);
    const missing = new DictationTranscriptSegments();
    missing.unqualified();
    missing.record({
      id: "later-qualified",
      position: 1,
      revision: 1,
      text: "insert snippet reply",
      final: true,
    });
    expect(missing.snapshot().qualified).toBe(false);
  });
});
