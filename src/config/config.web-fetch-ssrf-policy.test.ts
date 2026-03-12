import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("web_fetch ssrfPolicy config", () => {
  it("accepts canonical tools.web.fetch.ssrfPolicy fields", () => {
    const result = validateConfigObject({
      tools: {
        web: {
          fetch: {
            ssrfPolicy: {
              dangerouslyAllowPrivateNetwork: true,
              allowedHostnames: ["localhost"],
              hostnameAllowlist: ["*.example.com"],
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.tools?.web?.fetch?.ssrfPolicy).toEqual({
      dangerouslyAllowPrivateNetwork: true,
      allowedHostnames: ["localhost"],
      hostnameAllowlist: ["*.example.com"],
    });
  });
});
