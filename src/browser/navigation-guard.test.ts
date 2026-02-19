import { describe, expect, it } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

describe("browser navigation guard", () => {
  it("blocks private loopback URLs by default", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://127.0.0.1:8080",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("allows non-network schemes", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "about:blank",
      }),
    ).resolves.toBeUndefined();
  });

  it("allows localhost when explicitly allowed", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://localhost:3000",
        ssrfPolicy: {
          allowedHostnames: ["localhost"],
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects invalid URLs", async () => {
    await expect(
      assertBrowserNavigationAllowed({
        url: "not a url",
      }),
    ).rejects.toThrow(/Invalid URL/);
  });
});
