import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  setActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import {
  gitHubPublicApi,
  githubApiToken,
  hasConfiguredGitHubApiCredential,
} from "./github-public-api.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  clearRuntimeConfigSnapshot();
});

describe("Control UI GitHub credential", () => {
  it.each([
    { enabled: false },
    { entries: { github: { enabled: false } } },
    { allow: ["another-plugin"] },
  ])(
    "keeps the packaged host read library available independently of plugin activation: %j",
    async (plugins) => {
      setRuntimeConfigSnapshot({ plugins });
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: 1 }), {
          headers: { "content-type": "application/json" },
        }),
      );
      expect(gitHubPublicApi.resolveGitHubApiCredentialScope({}).token).toBeUndefined();
      await expect(
        gitHubPublicApi.fetchGitHubJson("https://api.github.com/user", fetchMock),
      ).resolves.toEqual({ id: 1 });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("keeps the explicit preview credential separate and preserves ambient fallback by omission", () => {
    const env = { GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github" };

    expect(githubApiToken(env, {})).toBe("ambient-gh");
    expect(
      githubApiToken(env, {
        gateway: { controlUi: { github: { token: "preview-service-token" } } },
        tools: {
          github: {
            profileId: "ghp_99999999999999999999999999999999",
          },
        },
      }),
    ).toBe("preview-service-token");
    expect(() =>
      githubApiToken(env, {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "PREVIEW_TOKEN" },
            },
          },
        },
      }),
    ).toThrow(SecretSurfaceUnavailableError);
  });

  it("fails closed for an explicitly configured cold SecretRef owner", () => {
    const config = {
      gateway: {
        controlUi: {
          github: {
            token: { source: "store" as const, provider: "default", id: "PREVIEW_TOKEN" },
          },
        },
      },
    };
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        degradationState: "cold",
        paths: ["gateway.controlUi.github.token"],
        refKeys: ["store:default:PREVIEW_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);

    expect(() => githubApiToken({ GH_TOKEN: "ambient" }, config)).toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(hasConfiguredGitHubApiCredential({}, config)).toBe(true);
    expect(githubApiToken({ GH_TOKEN: "ambient" }, {})).toBe("ambient");
  });
});
