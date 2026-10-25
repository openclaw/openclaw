import { expect, vi } from "vitest";
import type { TextProjection } from "./text-projection.js";

export function streamChunks(
  source: string,
  size: number,
  stream: { append: (chunk: string) => TextProjection; readonly text: string },
  inspect?: (result: TextProjection, end: number) => void,
) {
  let delivered = "";
  const deltas: string[] = [];
  for (let offset = 0; offset < source.length; offset += size) {
    const result = stream.append(source.slice(offset, offset + size));
    delivered = result.delta === null ? result.text : delivered + result.delta;
    deltas.push(result.delta ?? "");
    inspect?.(result, Math.min(offset + size, source.length));
  }
  return { text: stream.text, delivered, deltas };
}

export function regexWork(run: () => void, matches = (_regex: RegExp) => true) {
  const probe = vi.spyOn(RegExp.prototype, "test");
  try {
    run();
    return probe.mock.calls.reduce((total, [value], index) => {
      const regex = probe.mock.contexts[index];
      return (
        total +
        (typeof value === "string" && regex instanceof RegExp && matches(regex) ? value.length : 0)
      );
    }, 0);
  } finally {
    probe.mockRestore();
  }
}

export function expectPrefixParity(
  source: string,
  createStream: () => { append: (chunk: string) => TextProjection },
  transform: (text: string) => string,
) {
  const expected = Array.from({ length: source.length + 1 }, (_, end) =>
    transform(source.slice(0, end)),
  );
  const schedules = [
    ...Array.from({ length: source.length + 1 }, (_, split) => [split, source.length]),
    ...[1, 4].map((size) =>
      Array.from({ length: Math.ceil(source.length / size) }, (_, i) =>
        Math.min((i + 1) * size, source.length),
      ),
    ),
  ];
  for (const ends of schedules) {
    const stream = createStream();
    let start = 0;
    let delivered = "";
    for (const end of ends) {
      const result = stream.append(source.slice(start, end));
      delivered = result.delta === null ? result.text : delivered + result.delta;
      expect(result.text, JSON.stringify({ source, start, end })).toBe(expected[end]);
      expect(delivered).toBe(expected[end]);
      start = end;
    }
  }
  return expected.at(-1);
}
