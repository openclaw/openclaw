import { StringDecoder } from "node:string_decoder";

export function createRedactingStreamWriter(
  target: { write(text: string): boolean },
  redactValues: readonly string[],
): { write: (chunk: Buffer) => boolean; flush: () => void } {
  const decoder = new StringDecoder("utf8");
  const values = redactValues.filter(Boolean).toSorted((left, right) => right.length - left.length);
  const firstCharacters = new Set(values.map((value) => value.charAt(0)));
  let pending = "";
  const emit = (ending: boolean): boolean => {
    let output = "";
    let cursor = 0;
    while (cursor < pending.length) {
      const value = firstCharacters.has(pending.charAt(cursor))
        ? values.find(
            (candidate) =>
              pending.startsWith(candidate, cursor) ||
              (!ending &&
                pending.length - cursor < candidate.length &&
                candidate.startsWith(pending.slice(cursor))),
          )
        : undefined;
      if (!value) {
        output += pending[cursor];
        cursor += 1;
      } else if (cursor + value.length > pending.length) {
        // A longer possible match owns the tail until it completes or the stream ends.
        break;
      } else {
        output += "<redacted>";
        cursor += value.length;
      }
    }
    pending = pending.slice(cursor);
    return !output || target.write(output);
  };
  return {
    write: (chunk) => {
      pending += decoder.write(chunk);
      return emit(false);
    },
    flush: () => {
      pending += decoder.end();
      emit(true);
    },
  };
}
