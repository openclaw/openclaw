import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./github-copilot.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub Copilot OAuth model policy", () => {
  it("lists model ids from Copilot instead of the generated OpenClaw catalog", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-sonnet-4.6" },
              { id: "  gpt-5.5  " },
              { id: "embedding-model", capabilities: { type: "embeddings" } },
              { id: "accounts/example/router" },
              { id: "not-a-model", object: "assistant" },
              { id: "" },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(testing.listGitHubCopilotModelIds("copilot-token")).resolves.toEqual([
      "claude-sonnet-4.6",
      "gpt-5.5",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.individual.githubcopilot.com/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer copilot-token",
        }),
      }),
    );
  });

  it("treats model listing failures as optional policy setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );

    await expect(testing.listGitHubCopilotModelIds("copilot-token")).resolves.toEqual([]);
  });
});
