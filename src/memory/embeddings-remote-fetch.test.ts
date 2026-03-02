import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";
import { postJson } from "./post-json.js";

vi.mock("./post-json.js", () => ({
  postJson: vi.fn(),
}));

describe("fetchRemoteEmbeddingVectors", () => {
  const postJsonMock = vi.mocked(postJson);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps remote embedding response data to vectors", async () => {
    postJsonMock.mockImplementationOnce(async (params) => {
      return await params.parse({
        data: [{ embedding: [0.1, 0.2] }, {}, { embedding: [0.3] }],
      });
    });

    const vectors = await fetchRemoteEmbeddingVectors({
      url: "https://memory.example/v1/embeddings",
      headers: { Authorization: "Bearer test" },
      body: { input: ["one", "two", "three"] },
      errorPrefix: "embedding fetch failed",
    });

    expect(vectors).toEqual([[0.1, 0.2], [], [0.3]]);
    expect(postJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://memory.example/v1/embeddings",
        headers: { Authorization: "Bearer test" },
        body: { input: ["one", "two", "three"] },
        errorPrefix: "embedding fetch failed",
      }),
    );
  });

  it("throws a status-rich error on non-ok responses", async () => {
    postJsonMock.mockRejectedValueOnce(new Error("embedding fetch failed: 403 forbidden"));

    await expect(
      fetchRemoteEmbeddingVectors({
        url: "https://memory.example/v1/embeddings",
        headers: {},
        body: { input: ["one"] },
        errorPrefix: "embedding fetch failed",
      }),
    ).rejects.toThrow("embedding fetch failed: 403 forbidden");
  });
});
