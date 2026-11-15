import { afterEach, expect, it, vi } from "vitest";
import { jsonResponse } from "../test-helpers/http.js";
import { withEnvAsync } from "../test-utils/env.js";
import { fetchClawHubPluginCatalog } from "./clawhub-plugin-catalog.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["listing", undefined],
  ["search", "memory"],
] as const)("honors the caller's auth choice for catalog %s", async (_name, query) => {
  await withEnvAsync({ CLAWHUB_TOKEN: "ambient-test-token" }, async () => {
    const authorization: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      authorization.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(query ? { results: [] } : { items: [] });
    });

    for (const options of [
      { skipAuth: true },
      { skipAuth: true, token: "explicit-test-token" },
      { skipAuth: false },
    ]) {
      await expect(
        fetchClawHubPluginCatalog({
          baseUrl: "https://registry.example.invalid",
          query,
          ...options,
        }),
      ).resolves.toEqual({ items: [] });
    }

    expect(authorization).toEqual([null, null, "Bearer ambient-test-token"]);
  });
});
