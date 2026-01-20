import { describe, expect, it } from "vitest";

import { fetchDiscord } from "./api.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchDiscord", () => {
  it("formats rate limit payloads without raw JSON", async () => {
    const fetcher = async () =>
      jsonResponse(
        {
          message: "You are being rate limited.",
          retry_after: 0.631,
          global: false,
        },
        429,
      );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher as typeof fetch);
    } catch (err) {
      error = err;
    }

    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("You are being rate limited.");
    expect(message).toContain("retry after 0.6s");
    expect(message).not.toContain("{");
    expect(message).not.toContain("retry_after");
  });

  it("preserves non-JSON error text", async () => {
    const fetcher = async () => new Response("Not Found", { status: 404 });
    await expect(
      fetchDiscord("/users/@me/guilds", "test", fetcher as typeof fetch),
    ).rejects.toThrow("Discord API /users/@me/guilds failed (404): Not Found");
  });
});
