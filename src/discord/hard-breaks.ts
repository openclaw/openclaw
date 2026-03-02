type FenceState = {
  inFence: boolean;
  marker?: "`" | "~";
  length?: number;
};

function parseFenceDelimiter(line: string): { marker: "`" | "~"; length: number } | undefined {
  const trimmed = line.trimStart();
  if (trimmed.length < 3) {
    return undefined;
  }
  const first = trimmed[0];
  if (first !== "`" && first !== "~") {
    return undefined;
  }
  let length = 0;
  while (trimmed[length] === first) {
    length += 1;
  }
  if (length < 3) {
    return undefined;
  }
  return {
    marker: first,
    length,
  };
}

function nextFenceState(state: FenceState, line: string): FenceState {
  const delimiter = parseFenceDelimiter(line);
  if (!delimiter) {
    return state;
  }
  if (!state.inFence) {
    return {
      inFence: true,
      marker: delimiter.marker,
      length: delimiter.length,
    };
  }
  if (state.marker === delimiter.marker && delimiter.length >= (state.length ?? 3)) {
    return { inFence: false };
  }
  return state;
}

function shouldConvertSingleNewline(
  currentLine: string,
  nextLine: string,
  fenceStateAfterCurrentLine: FenceState,
): boolean {
  if (fenceStateAfterCurrentLine.inFence) {
    return false;
  }
  if (!currentLine.trim() || !nextLine.trim()) {
    return false;
  }
  if (parseFenceDelimiter(currentLine) || parseFenceDelimiter(nextLine)) {
    return false;
  }
  return true;
}

/**
 * Convert single newlines into hard breaks (`"  \n"`) for Discord markdown,
 * while preserving paragraph breaks and fenced code blocks.
 */
export function applyDiscordAutoHardBreaks(text: string): string {
  if (!text.includes("\n")) {
    return text;
  }
  const lines = text.split("\n");
  const output: string[] = [];
  let fenceState: FenceState = { inFence: false };

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index] ?? "";
    output.push(currentLine);
    if (index === lines.length - 1) {
      continue;
    }
    const nextLine = lines[index + 1] ?? "";
    fenceState = nextFenceState(fenceState, currentLine);
    output.push(shouldConvertSingleNewline(currentLine, nextLine, fenceState) ? "  \n" : "\n");
  }

  return output.join("");
}
