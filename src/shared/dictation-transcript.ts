export type DictationTranscriptSegment = {
  id: string;
  position: number;
  revision: number;
  text: string;
  final: boolean;
};

/** A bounded projection of the capture owner's canonical Talk receipts, not a history store. */
export class DictationTranscriptSegments {
  private readonly segments = new Map<string, DictationTranscriptSegment>();
  private revision = 0;
  private qualified = true;

  record(segment: DictationTranscriptSegment): boolean {
    if (
      !segment.id ||
      !Number.isSafeInteger(segment.position) ||
      segment.position < 0 ||
      !Number.isSafeInteger(segment.revision) ||
      segment.revision < 0 ||
      segment.text.length > 128 * 1024
    ) {
      this.qualified = false;
      return false;
    }
    const previous = this.segments.get(segment.id);
    if (previous && (segment.revision <= previous.revision || (previous.final && !segment.final))) {
      return false;
    }
    if (!previous && this.segments.size >= 128) {
      this.qualified = false;
      return false;
    }
    this.segments.set(segment.id, {
      ...segment,
      position: previous ? Math.min(previous.position, segment.position) : segment.position,
    });
    this.revision = Math.max(this.revision, segment.revision);
    return true;
  }

  unqualified(): void {
    this.qualified = false;
  }

  snapshot(): { text: string; revision: number; finalized: boolean; qualified: boolean } {
    const segments = [...this.segments.values()].toSorted((a, b) => a.position - b.position);
    const text = segments
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(" ");
    return {
      text,
      revision: this.revision,
      finalized: segments.length > 0 && segments.every((segment) => segment.final),
      qualified: this.qualified && new TextEncoder().encode(text).byteLength <= 128 * 1024,
    };
  }
}
