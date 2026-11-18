import { expect, vi } from "vitest";
import { requestUrl } from "../test-helpers/http.js";

/** Capture real request normalization while supplying a fixed wire response. */
export function captureClawHubResponse(response: Response | (() => Response)) {
  let url: URL;
  let init: RequestInit | undefined;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    url = new URL(requestUrl(input));
    init = options;
    return typeof response === "function" ? response() : response;
  });
  return {
    fetch,
    url: () => url,
    init: () => init,
    body: (): unknown => {
      const body = init?.body;
      expect(typeof body).toBe("string");
      if (typeof body !== "string") {
        throw new Error("Expected JSON request body");
      }
      return JSON.parse(body);
    },
  };
}

export const captureClawHubJson = (body: unknown) =>
  captureClawHubResponse(() => Response.json(body));
