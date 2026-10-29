import { Hash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { GatewayControlUiConfig as UiConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setActiveDegradedSecretOwners([]);
  clearRuntimeConfigSnapshot();
});

const coldToken = { source: "store", provider: "default", id: "PREVIEW_TOKEN" } as const;
const enterpriseHost = "ghe.example.test";
const ambient = { GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github" };
function previewConfig(github: UiConfig["github"], host?: string): OpenClawConfig {
  return { gateway: { github: { host }, controlUi: { github } } };
}

it.each([
  { enabled: false },
  { entries: { github: { enabled: false } } },
  { allow: ["another-plugin"] },
])("keeps host reads available with plugins %j", async (plugins) => {
  setRuntimeConfigSnapshot({ plugins });
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 1 }));
  expect(gitHubPublicApi.resolveGitHubApiCredentialScope({}).token).toBeUndefined();
  await expect(
    gitHubPublicApi.fetchGitHubJson("https://api.github.com/user", fetchMock),
  ).resolves.toEqual({ id: 1 });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([
  ["ambient fallback", {}, "ambient-gh"],
  ["no public token on Enterprise", previewConfig(undefined, enterpriseHost), undefined],
  [
    "separate preview credential",
    {
      ...previewConfig({ token: "preview-service-token" }),
      tools: { github: { profileId: "ghp_99999999999999999999999999999999" } },
    },
    "preview-service-token",
  ],
  [
    "host-bound Enterprise credential",
    previewConfig({ host: enterpriseHost, token: "enterprise-token" }, enterpriseHost),
    "enterprise-token",
  ],
] satisfies [string, OpenClawConfig, string | undefined][])("%s", (_name, config, expected) => {
  expect(githubApiToken(ambient, config)).toBe(expected);
});

it.each([
  ["unmaterialized SecretRef", previewConfig({ token: coldToken }), true],
  ["mismatched host", previewConfig({ token: "public-service-token" }, enterpriseHost), false],
] satisfies [string, OpenClawConfig, boolean][])(
  "fails closed for %s",
  (_name, config, configured) => {
    expect(() => githubApiToken({ GH_TOKEN: "public-token" }, config)).toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(hasConfiguredGitHubApiCredential({}, config)).toBe(configured);
  },
);

it("does not rehash credentials during live checks for interleaved cached preview readers", async () => {
  const hash = vi.spyOn(Hash.prototype, "update");
  const target = { owner: "synthetic", repo: "preview", kind: "issue" as const, number: 1 };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return Response.json(
      url.endsWith("/issues/1")
        ? {
            title: new Headers(init?.headers).get("Authorization") ?? "Anonymous preview",
            state: "open",
            user: { login: "synthetic" },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            repository_url: "https://api.github.com/repos/synthetic/preview",
          }
        : { private: false, visibility: "public" },
    );
  });
  const select = (token: string) => setRuntimeConfigSnapshot(previewConfig({ token }));
  const read = () => gitHubPublicApi.loadControlUiGitHubPreview(target, undefined, fetchMock);
  for (const token of ["synthetic-first", " synthetic-second "]) {
    select(token);
    await read();
  }
  hash.mockClear();
  fetchMock.mockClear();
  select("synthetic-first");
  const first = read();
  select("synthetic-second");
  const second = read();
  await expect(first).rejects.toThrow("GitHub credential changed");
  await expect(second).resolves.toMatchObject({ title: "Bearer synthetic-second" });
  expect(
    hash.mock.calls.filter(([data]) => data === "synthetic-first" || data === "synthetic-second"),
  ).toHaveLength(4);
  expect(fetchMock).not.toHaveBeenCalled();

  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  for (const changed of [
    previewConfig(undefined, enterpriseHost),
    { gateway: { github: { apiBaseUrl: "https://api.example.test" } } },
  ]) {
    setRuntimeConfigSnapshot({});
    await read();
    const anonymous = read();
    setRuntimeConfigSnapshot(changed);
    await expect(anonymous).rejects.toThrow("GitHub credential changed");
  }
});
