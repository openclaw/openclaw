import { expect, it, vi } from "vitest";

// mock-isolation: Identity imports must not initialize artifact or codec runtime.
vi.mock("../config/sessions/artifacts.js", () => {
  throw new Error("Session-key runtime loaded session artifacts");
});
// mock-isolation: Compression must remain outside the identity import graph.
vi.mock("../config/sessions/archive-compression.js", () => {
  throw new Error("Session-key runtime loaded archive compression");
});
// mock-isolation: Importing identities must not initialize native codecs.
vi.mock("../infra/zstd-codec.js", () => {
  throw new Error("Session-key runtime loaded the zstd codec");
});

it("parses transcript identities without loading artifact or compression runtime", async () => {
  const { parseUsageCountedSessionIdFromFileName } = await import("./session-key-runtime.js");
  expect(
    parseUsageCountedSessionIdFromFileName("fixture.jsonl.deleted.2026-10-14T12-00-00.000Z.zst"),
  ).toBe("fixture");
});
