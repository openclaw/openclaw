import { describe, expect, it } from "vitest";
import { oversizedJsonResponse } from "./provider-http.js";

describe("provider HTTP fixtures", () => {
  it("caps the default stream while reusing its immutable chunk", async () => {
    const { response, state } = oversizedJsonResponse();
    const chunks = new Set<Uint8Array>();
    let reads = 0;
    for await (const chunk of response.body!) {
      expect(chunk.byteLength).toBe(1024 * 1024);
      chunks.add(chunk);
      reads += 1;
    }

    expect(reads).toBe(64);
    expect(chunks.size).toBe(1);
    expect([...chunks][0]?.every((byte) => byte === 0)).toBe(true);
    expect(state).toEqual({ canceled: false, enqueuedBytes: 64 * 1024 * 1024 });
  });

  it("preserves default stream cancellation", async () => {
    const { response, state } = oversizedJsonResponse();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(state.canceled).toBe(true);
  });

  it("tracks bounded oversized response reads and cancellation", async () => {
    const fixture = oversizedJsonResponse({ chunkCount: 2, chunkSize: 4 });
    const reader = fixture.response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    expect(fixture.getReadCount()).toBe(1);
    expect(fixture.wasCanceled()).toBe(true);
  });
});
