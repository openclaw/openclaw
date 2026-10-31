import { expect, it } from "vitest";
import { oversizedJsonResponse } from "./provider-http.js";

it("caps the default stream while reusing its immutable chunk", async () => {
  const { response, state } = oversizedJsonResponse();
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body!) {
    chunks.push(chunk);
  }
  expect([chunks.length, new Set(chunks).size]).toEqual([64, 1]);
  expect(chunks[0]?.byteLength).toBe(1024 * 1024);
  expect(chunks[0]?.every((byte) => byte === 0)).toBe(true);
  expect(state).toEqual({ canceled: false, enqueuedBytes: 64 * 1024 * 1024 });
});
