import type { MarkdownIt } from "markdown-it";

// formatAudioTranscriptForAgent stores this model-facing label in conversation history.
const AUDIO_TRANSCRIPT_PREFIX = '[Audio transcript (machine-generated, untrusted)]: "';

export function installMarkdownAudioTranscript(markdownParser: MarkdownIt): void {
  markdownParser.block.ruler.before(
    "reference",
    "audio_transcript",
    (state, startLine, _endLine, silent) => {
      if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) {
        return false;
      }
      const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
      const end = state.eMarks[startLine] ?? state.src.length;
      const line = state.src.slice(start, end);
      if (!line.startsWith(AUDIO_TRANSCRIPT_PREFIX)) {
        return false;
      }
      if (silent) {
        return true;
      }
      // Without this presentation adapter, a transcript without spaces is a hidden
      // Markdown link definition. Keep the persisted and model-facing bytes intact.
      state.push("paragraph_open", "p", 1).map = [startLine, startLine + 1];
      const inline = state.push("inline", "", 0);
      inline.content = `\\${line}`;
      inline.map = [startLine, startLine + 1];
      inline.children = [];
      state.push("paragraph_close", "p", -1);
      state.line = startLine + 1;
      return true;
    },
    { alt: ["reference"] },
  );
}
