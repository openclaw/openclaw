import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightNpmTrustedPublisher } from "../../scripts/npm-trusted-publisher-preflight.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let invalidateTooling: () => void;
let advanceSource: () => void;

const githubRequestToken = "github-request-secret";
const githubOidcToken = "github-oidc-secret";
const npmToken = "npm-exchange-secret";
const packageName = "@openclaw/fish-audio-speech";
const preflight = () => preflightNpmTrustedPublisher(packageName);
const requestUrl = "https://token.actions.githubusercontent.com/request?job=123";
const auth = (token: string) => ({ Accept: "application/json", Authorization: `Bearer ${token}` });
const exchange = (body: unknown, status = 200) => [
  Response.json({ value: githubOidcToken }),
  Response.json(body, { status }),
];

function mockResponses(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("npm trusted-publisher preflight", () => {
  beforeEach(() => {
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", requestUrl);
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", githubRequestToken);
    const root = tempDirs.make("npm-preflight-authority-");
    const remote = join(root, "remote");
    const source = join(root, "source");
    const bin = join(root, "bin");
    mkdirSync(remote);
    mkdirSync(bin);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", remote, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "--initial-branch=main");
    writeFileSync(join(remote, "package.json"), JSON.stringify({ version: "2026.8.33" }));
    git("add", "package.json");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "source",
    );
    const sha = git("rev-parse", "HEAD");
    git("branch", "extended-stable/2026.8.33");
    execFileSync("git", ["clone", remote, source], { stdio: "pipe" });
    const tag = `release-publish/${sha.slice(0, 12)}-123`;
    const tagState = join(root, "tag.json");
    writeFileSync(
      tagState,
      JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: "commit", sha } }),
    );
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}\nimport { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(tagState)}, "utf8"));\n`,
      { mode: 0o755 },
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      CI_GIT_OWNER: resolve(".github/actions/git-owner/owner.py"),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_WORKSPACE: source,
      WORKFLOW_REF: `refs/tags/${tag}`,
      WORKFLOW_REF_NAME: tag,
      WORKFLOW_SHA: sha,
      SOURCE_REF: sha,
      PREFLIGHT_ONLY: "true",
      TRUSTED_PUBLISHER_PREFLIGHT: "true",
      REQUIRE_NPM_PUBLISH_ENVIRONMENT: "true",
      PREPARED_ARTIFACT: "",
      NPM_DIST_TAG: "default",
      PUBLISH_SCOPE: "selected",
      RELEASE_PLUGINS: packageName,
      RELEASE_PUBLISH_RUN_ID: "",
      RELEASE_PUBLISH_RUN_ATTEMPT: "",
      RELEASE_CANDIDATE_BRANCH: "",
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    invalidateTooling = () =>
      writeFileSync(
        tagState,
        JSON.stringify({
          ref: `refs/tags/${tag}`,
          object: { type: "commit", sha: "f".repeat(40) },
        }),
      );
    advanceSource = () => {
      git("checkout", "extended-stable/2026.8.33");
      writeFileSync(join(remote, "next.txt"), "next candidate");
      git("add", "next.txt");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "advance canonical source",
      );
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the npm audience and exchanges the GitHub token for the exact package", async () => {
    const fetchMock = mockResponses(...exchange({ token: npmToken }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await preflight();

    expect(fetchMock.mock.calls).toMatchObject([
      [`${requestUrl}&audience=npm%3Aregistry.npmjs.org`, { headers: auth(githubRequestToken) }],
      [
        "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@openclaw%2ffish-audio-speech",
        { method: "POST", headers: auth(githubOidcToken) },
      ],
    ]);
    expect(log).toHaveBeenCalledWith(
      "npm trusted-publisher OIDC exchange verified for @openclaw/fish-audio-speech.",
    );
  });

  it.each(["tooling moved", "canonical source advanced"])(
    "refuses npm credential exchange when %s during GitHub token acquisition",
    async (change) => {
      if (change === "canonical source advanced") {
        vi.stubEnv("NPM_DIST_TAG", "extended-stable");
        vi.stubEnv("PUBLISH_SCOPE", "all-publishable");
        vi.stubEnv("RELEASE_PLUGINS", "");
      }
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (url === `${requestUrl}&audience=npm%3Aregistry.npmjs.org`) {
          if (change === "tooling moved") {
            invalidateTooling();
          } else {
            advanceSource();
          }
          return Response.json({ value: githubOidcToken });
        }
        return Response.json({ token: npmToken });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(preflight()).rejects.toThrow(
        change === "tooling moved"
          ? "protected release tooling tag is missing, moved"
          : "source must equal the exact extended-stable/2026.8.33 branch tip",
      );
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${requestUrl}&audience=npm%3Aregistry.npmjs.org`,
      ]);
    },
  );

  it.each([
    ["GitHub OIDC token request failed (HTTP 403).", () => [Response.json({}, { status: 403 })], 1],
    [
      `npm trusted-publisher exchange for ${packageName} failed (HTTP 404).`,
      () => exchange({ message: `${githubRequestToken} ${githubOidcToken} ${npmToken}` }, 404),
      2,
    ],
    [
      `npm trusted-publisher exchange for ${packageName} response is missing token.`,
      () => exchange({ token: "" }),
      2,
    ],
  ] as const)("reports %s without leaking tokens", async (message, responses, calls) => {
    const fetchMock = mockResponses(...responses());
    const error = await preflight().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const visibleError = error instanceof Error ? error.message : String(error);
    expect(visibleError).toBe(message);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    for (const token of [githubRequestToken, githubOidcToken, npmToken]) {
      expect(visibleError).not.toContain(token);
    }
  });
});
