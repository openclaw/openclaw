import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { prepareTrajectoryPayload, readTrajectoryPayload } from "./runtime-payload.js";

const database = new DatabaseSync(":memory:");
afterAll(() => database.close());

describe("trajectory payload encoding", () => {
  it("round-trips original JSON bytes, including Unicode, whitespace and escaped characters", () => {
    const line = ` { "payload": ${JSON.stringify("日本語🦞\u0000\\u0000".repeat(500))} } `;
    const row = prepareTrajectoryPayload(database, line, "UTF-8");
    expect(row.event_codec).toBe("br");
    expect(row.event_json).toBe("");
    expect(row.event_payload!.byteLength).toBeLessThan(Buffer.byteLength(line) / 2);
    expect(row.event_utf8_bytes).toBe(Buffer.byteLength(line));
    expect(readTrajectoryPayload(row)).toBe(line);
  });

  it("keeps small, oversized and non-round-trippable values as original text", () => {
    for (const line of [
      "x".repeat(1023),
      "x".repeat(256 * 1024 + 1),
      "x".repeat(1024) + "\ud800",
    ]) {
      const row = prepareTrajectoryPayload(database, line, "UTF-8");
      expect(row.event_codec).toBeNull();
      expect(row.event_payload).toBeNull();
      expect(row.event_json).toBe(line);
      expect(readTrajectoryPayload(row)).toBe(line);
    }
  });

  it.each(["UTF-16le", "UTF-16be"])("preserves native text accounting in %s", (encoding) => {
    const line = "日本語🦞".repeat(500);
    expect(prepareTrajectoryPayload(database, line, encoding)).toEqual({
      event_json: line,
      event_payload: null,
      event_codec: null,
      event_utf8_bytes: null,
    });
  });

  it("bounds damaged frames and rejects unknown codecs and inconsistent lengths", () => {
    const row = prepareTrajectoryPayload(database, "x".repeat(2048), "UTF-8");
    expect(() => readTrajectoryPayload({ ...row, event_codec: "future" })).toThrow(
      "Unsupported trajectory payload codec",
    );
    expect(() => readTrajectoryPayload({ ...row, event_payload: new Uint8Array([255]) })).toThrow();
    expect(() => readTrajectoryPayload({ ...row, event_utf8_bytes: 2049 })).toThrow(
      "length does not match",
    );
    expect(() =>
      readTrajectoryPayload({
        ...row,
        event_utf8_bytes: 256 * 1024 + 1,
      }),
    ).toThrow("bounds");
    expect(() =>
      readTrajectoryPayload({
        ...row,
        event_payload: brotliCompressSync("x".repeat(256 * 1024 + 1)),
        event_utf8_bytes: 256 * 1024,
      }),
    ).toThrow();
  });
});
