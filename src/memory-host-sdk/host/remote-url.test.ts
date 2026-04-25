import { describe, expect, it } from "vitest";
import { joinRemoteEndpoint } from "./remote-url.js";

describe("joinRemoteEndpoint", () => {
  it("joins a base URL without a trailing slash", () => {
    expect(joinRemoteEndpoint("https://openrouter.ai/api/v1", "/embeddings")).toBe(
      "https://openrouter.ai/api/v1/embeddings",
    );
  });

  it("joins a base URL with one trailing slash", () => {
    expect(joinRemoteEndpoint("https://openrouter.ai/api/v1/", "/embeddings")).toBe(
      "https://openrouter.ai/api/v1/embeddings",
    );
  });

  it("joins a base URL with multiple trailing slashes", () => {
    expect(joinRemoteEndpoint("https://openrouter.ai/api/v1///", "/embeddings")).toBe(
      "https://openrouter.ai/api/v1/embeddings",
    );
  });

  it("requires endpoint paths to start with a slash", () => {
    expect(() => joinRemoteEndpoint("https://openrouter.ai/api/v1", "embeddings")).toThrow(
      "Remote endpoint path must start with '/'",
    );
  });

  it("rejects base URLs with query strings", () => {
    expect(() =>
      joinRemoteEndpoint("https://openrouter.ai/api/v1?token=secret", "/embeddings"),
    ).toThrow("Remote base URL must not include a query string or fragment");
  });
});
