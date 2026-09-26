const PROGRESS_CARD_RAW_CONTENT_TAGS = [
  { name: "script", pattern: /^script$/iu },
  { name: "style", pattern: /^style$/iu },
  { name: "iframe", pattern: /^iframe$/iu },
  { name: "object", pattern: /^object$/iu },
  { name: "template", pattern: /^template$/iu },
];
const PROGRESS_CARD_RAW_CONTENT_WORD_CHARACTER_RE = /^\w$/iu;
const PROGRESS_CARD_RAW_CONTENT_WHITESPACE_RE = /^\s$/u;

interface ProgressCardRawContentTag {
  end: number;
  isClosing: boolean;
  name: string;
  start: number;
}

function readProgressCardRawContentTag(
  input: string,
  start: number,
  close: number,
): ProgressCardRawContentTag | null {
  let nameStart = start + 1;
  const isClosing = input[nameStart] === "/";
  if (isClosing) {
    nameStart += 1;
  }
  const candidate = PROGRESS_CARD_RAW_CONTENT_TAGS.find((entry) => {
    const nameEnd = nameStart + entry.name.length;
    return (
      entry.pattern.test(input.slice(nameStart, nameEnd)) &&
      !PROGRESS_CARD_RAW_CONTENT_WORD_CHARACTER_RE.test(input[nameEnd] ?? "")
    );
  });
  if (!candidate) {
    return null;
  }
  const name = candidate.name;
  const nameEnd = nameStart + name.length;
  if (isClosing) {
    for (let index = nameEnd; index < close; index += 1) {
      if (!PROGRESS_CARD_RAW_CONTENT_WHITESPACE_RE.test(input[index] ?? "")) {
        return null;
      }
    }
  }
  return { start, end: close + 1, isClosing, name };
}

export function stripProgressCardRawContentBlocks(input: string): string {
  const tags: ProgressCardRawContentTag[] = [];
  let searchFrom = 0;
  let nextClose = input.indexOf(">");
  while (searchFrom < input.length) {
    const start = input.indexOf("<", searchFrom);
    if (start === -1) {
      break;
    }
    while (nextClose !== -1 && nextClose < start) {
      nextClose = input.indexOf(">", nextClose + 1);
    }
    if (nextClose === -1) {
      break;
    }
    const tag = readProgressCardRawContentTag(input, start, nextClose);
    if (tag) {
      tags.push(tag);
    }
    // A candidate tag can contain another '<' before its closing '>'. Keep
    // inspecting those starts so an embedded raw-block closer remains visible
    // to the pairing pass, matching the previous regex's search semantics.
    searchFrom = start + 1;
  }

  // Pair each opener with the first compatible close after the opener ends.
  // Closing-tag positions are monotonic, so binary search avoids rescanning the
  // remaining message for every unmatched opening tag.
  const closingTagsByName = new Map<string, number[]>();
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag?.isClosing) {
      continue;
    }
    const indices = closingTagsByName.get(tag.name) ?? [];
    indices.push(index);
    closingTagsByName.set(tag.name, indices);
  }
  let output = "";
  let cursor = 0;
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag || tag.isClosing) {
      continue;
    }
    const closingIndices = closingTagsByName.get(tag.name);
    if (!closingIndices) {
      continue;
    }
    let low = 0;
    let high = closingIndices.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const closeIndex = closingIndices[middle];
      const close = closeIndex === undefined ? undefined : tags[closeIndex];
      if (close && close.start >= tag.end) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    const closeIndex = closingIndices[low];
    const close = closeIndex === undefined ? undefined : tags[closeIndex];
    if (!close) {
      continue;
    }
    output += input.slice(cursor, tag.start);
    cursor = close.end;
    while ((tags[index + 1]?.start ?? Number.POSITIVE_INFINITY) < cursor) {
      index += 1;
    }
  }
  return cursor === 0 ? input : output + input.slice(cursor);
}
