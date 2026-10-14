import { afterEach, expect, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";

afterEach(() => clearRuntimeConfigSnapshot());

test("Gateway GitHub reads use the configured Enterprise Server API", async () => {
  setRuntimeConfigSnapshot({
    gateway: {
      github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
    },
  });
  const { gitHubPublicApi } = await import("./github-public-api.js");
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));

  expect(gitHubPublicApi.GITHUB_API_BASE_URL).toBe("https://ghe.example.test/api/v3");
  await gitHubPublicApi.fetchGitHubApi(
    "https://ghe.example.test/api/v3/repos/acme/private-repo",
    fetchImpl,
  );
  expect(fetchImpl).toHaveBeenCalledWith(
    "https://ghe.example.test/api/v3/repos/acme/private-repo",
    expect.any(Object),
  );
});
