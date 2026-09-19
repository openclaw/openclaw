import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export type StreamOutputChannel = "stdout" | "stderr";

// A drop severs the retained partial line, but only a "midline" drop leaves
// the next fragment's head inside an unknown line.
export type DroppedTail = false | "clean" | "midline";

export type BufferedOutput = {
  channel: StreamOutputChannel;
  chunk: string;
  generation: number;
  truncatedTail: boolean;
  truncatedTailContinuesLine: boolean;
  precededByDrop: DroppedTail;
};

export function* remainingCronStreamLines(params: {
  partialLines: Record<StreamOutputChannel, string>;
  discardUntilNewline: Record<StreamOutputChannel, boolean>;
  droppedChunkTail: Record<StreamOutputChannel, DroppedTail>;
  bufferedOutput: BufferedOutput[];
  maxLineBytes: number;
  includeTruncated: boolean;
}): Generator<string> {
  for (const channel of ["stdout", "stderr"] as const) {
    let text = params.partialLines[channel];
    let discardUntilNewline = params.discardUntilNewline[channel];
    for (const entry of params.bufferedOutput) {
      if (entry.channel !== channel) {
        continue;
      }
      if (entry.precededByDrop) {
        text = "";
        discardUntilNewline = entry.precededByDrop === "midline";
      }
      text += entry.chunk;
      for (;;) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const rawLine = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (discardUntilNewline) {
          discardUntilNewline = false;
          continue;
        }
        const overCap = Buffer.byteLength(rawLine, "utf8") > params.maxLineBytes;
        if (params.includeTruncated || !overCap) {
          const line = overCap ? truncateUtf8Prefix(rawLine, params.maxLineBytes) : rawLine;
          yield line.endsWith("\r") ? line.slice(0, -1) : line;
        }
      }
      if (discardUntilNewline) {
        text = "";
        continue;
      }
      // Finish this chunk before applying the next chunk's dropped-gap boundary.
      if (entry.truncatedTail || Buffer.byteLength(text, "utf8") > params.maxLineBytes) {
        if (params.includeTruncated && text) {
          const line = truncateUtf8Prefix(text, params.maxLineBytes);
          yield line.endsWith("\r") ? line.slice(0, -1) : line;
        }
        text = "";
        discardUntilNewline = entry.truncatedTail ? entry.truncatedTailContinuesLine : true;
      }
    }
    if (discardUntilNewline || !text) {
      continue;
    }
    // A dropped continuation leaves the final line indeterminate in both modes.
    if (
      params.droppedChunkTail[channel] ||
      (!params.includeTruncated && Buffer.byteLength(text, "utf8") > params.maxLineBytes)
    ) {
      continue;
    }
    yield text.endsWith("\r") ? text.slice(0, -1) : text;
  }
}
