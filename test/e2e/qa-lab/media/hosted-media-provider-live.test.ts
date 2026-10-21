import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_SUITES,
  buildRunPlan,
  buildHostedMediaCommand,
  buildHostedMediaEvidence,
  classifyHostedMediaFailureStatus,
  findSkippedExplicitProviderSelections,
  parseArgs,
  parseHostedMediaOptions,
  runCli,
  type SuiteRunPlan,
} from "./hosted-media-provider-live.js";

const SOURCE_PATH = "test/e2e/qa-lab/media/hosted-media-provider-live.ts";
const loadShellEnvFallbackMock = vi.fn();
const collectProviderApiKeysMock = vi.fn((provider: string) =>
  process.env[`TEST_AUTH_${provider.toUpperCase()}`] ? ["test-key"] : [],
);
const planDependencies = {
  collectProviderApiKeysImpl: collectProviderApiKeysMock,
  getProviderEnvVarsImpl: (provider: string) => [`TEST_AUTH_${provider.toUpperCase()}`],
  loadShellEnvFallbackImpl: loadShellEnvFallbackMock,
};
const emptyPlan = (): SuiteRunPlan[] => [
  {
    providers: [],
    skippedReason: "no providers with usable auth",
    suite: MEDIA_SUITES.image,
  },
];
const hostedOptions = (suite: string, ...args: string[]) =>
  parseHostedMediaOptions([
    "--suite",
    suite,
    "--artifact-base",
    path.join(os.tmpdir(), "openclaw-hosted-media-live-test", suite),
    ...args,
  ]);

afterEach(() => {
  collectProviderApiKeysMock.mockClear();
  loadShellEnvFallbackMock.mockReset();
  vi.unstubAllEnvs();
});

describe("hosted media provider live QA producer", () => {
  it("builds the image live media command with provider filters from env", () => {
    const command = buildHostedMediaCommand({
      env: { OPENCLAW_QA_HOSTED_MEDIA_PROVIDERS: "openai,google" },
      options: hostedOptions("image", "--providers-env", "OPENCLAW_QA_HOSTED_MEDIA_PROVIDERS"),
    });

    expect(command.args).toEqual(
      expect.arrayContaining([SOURCE_PATH, "image", "--image-providers", "openai,google"]),
    );
    expect(command.env.OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES).toBeUndefined();
  });

  it("forces full video modes so reference image and video inputs are covered", () => {
    const command = buildHostedMediaCommand({ env: {}, options: hostedOptions("video") });

    expect(command.args).toContain("video");
    expect(command.env.OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES).toBe("1");
  });

  it("classifies missing live media auth as blocked evidence", () => {
    expect(
      classifyHostedMediaFailureStatus(
        "[live:media] no runnable providers matched available auth; pass --allow-empty",
      ),
    ).toBe("blocked");
    expect(classifyHostedMediaFailureStatus("provider response was malformed")).toBe("fail");
  });

  it("binds video provider coverage from the scenario catalog", () => {
    const evidence = buildHostedMediaEvidence({
      options: hostedOptions("video"),
      result: { durationMs: 10, status: "pass" },
    });

    expect(evidence.entries[0]?.coverage).toEqual([
      { id: "hosted-providers.video-generation-providers", role: "primary" },
      { id: "media.reference-image-video-and-audio-inputs", role: "primary" },
      { id: "media.video-generation-tool-invocation", role: "secondary" },
    ]);
  });
});

describe("hosted media provider live CLI", () => {
  it.each([
    [
      "--providers",
      "definitely-not-a-provider",
      "Unknown provider(s) for selected media suite(s): definitely-not-a-provider",
    ],
    ["--image-providers", "runway", "Unknown image provider(s): runway"],
    ["--music-providers", "fal", "Provider filter(s) target unselected media suite(s): music"],
  ])("rejects invalid image selection %s=%s", (flag, provider, error) => {
    expect(() => parseArgs(["image", flag, provider, "--all-providers"])).toThrow(error);
  });

  it.each([
    ["image", "openrouter"],
    ["music", "fal,openrouter"],
    ["video", "openrouter"],
  ] as const)("accepts %s providers %s", (suite, providers) => {
    expect(
      parseArgs([suite, `--${suite}-providers`, providers, "--all-providers"]).suiteProviders[
        suite
      ],
    ).toEqual(new Set(providers.split(",")));
  });

  it("passes single-dash Vitest args after the option separator", () => {
    expect(
      parseArgs(["image", "--all-providers", "--project", "tooling", "--", "-t", "media-smoke"]),
    ).toMatchObject({
      suites: ["image"],
      requireAuth: false,
      passthroughArgs: ["--project", "tooling", "-t", "media-smoke"],
    });
  });

  it("fails explicit suite selections that auth filtering would skip", () => {
    const options = parseArgs([
      "image",
      "music",
      "--image-providers",
      "openai",
      "--music-providers",
      "minimax",
    ]);
    const skipped = findSkippedExplicitProviderSelections(options, [
      { suite: MEDIA_SUITES.image, providers: ["openai"] },
      {
        suite: MEDIA_SUITES.music,
        providers: [],
        skippedReason: "no providers with usable auth",
      },
    ]);

    expect(skipped.map((entry) => entry.suite.id)).toEqual(["music"]);
  });

  it("does not fail global provider filters for suites without provider overlap", () => {
    const options = parseArgs(["image", "music", "video", "--providers", "openai"]);
    const skipped = findSkippedExplicitProviderSelections(options, [
      { suite: MEDIA_SUITES.image, providers: ["openai"] },
      {
        suite: MEDIA_SUITES.music,
        providers: [],
        skippedReason: "no providers selected",
      },
      { suite: MEDIA_SUITES.video, providers: [], skippedReason: "no providers selected" },
    ]);

    expect(skipped).toEqual([]);
  });

  it.each([
    { args: ["image"], exit: 1 },
    { args: ["image", "--allow-empty"], exit: 0 },
  ])("empty run $args exits $exit", async ({ args, exit }) => {
    await expect(runCli(args, { buildRunPlanImpl: emptyPlan })).resolves.toBe(exit);
  });

  it("defaults to all suites with auth filtering", async () => {
    for (const provider of ["OPENAI", "GOOGLE", "KIE", "MINIMAX", "FAL", "VYDRA"]) {
      vi.stubEnv(`TEST_AUTH_${provider}`, "1");
    }
    const plan = await buildRunPlan(parseArgs([]), planDependencies);

    expect(plan.map(({ suite, providers }) => [suite.id, providers])).toEqual([
      ["image", "fal,google,minimax,openai,vydra".split(",")],
      ["music", ["fal", "google", "minimax"]],
      ["video", "google,kie,minimax,vydra".split(",")],
    ]);
  });

  it("supports suite-specific provider filters without auth narrowing", async () => {
    const plan = await buildRunPlan(
      parseArgs([
        "video",
        "--video-providers",
        "fal,google,kie,novita,pixverse,runway,zai",
        "--all-providers",
      ]),
      planDependencies,
    );

    expect(plan).toMatchObject([
      { suite: { id: "video" }, providers: "fal,google,kie,novita,pixverse,runway,zai".split(",") },
    ]);
  });

  it("forwards quiet flags separately from passthrough args", () => {
    expect(parseArgs(["image", "--quiet", "--reporter", "dot"])).toMatchObject({
      suites: ["image"],
      quietArgs: ["--quiet"],
      passthroughArgs: ["--reporter", "dot"],
    });
  });
});
