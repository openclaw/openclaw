import os from "node:os";
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
  type MediaSuiteId,
  type SuiteRunPlan,
} from "./hosted-media-provider-live.js";

const SOURCE_PATH = "test/e2e/qa-lab/media/hosted-media-provider-live.ts";
const cli = (args: string) => parseArgs(args.split(" "));
const planDependencies = {
  collectProviderApiKeysImpl: (provider: string) =>
    process.env[`TEST_AUTH_${provider.toUpperCase()}`] ? ["test-key"] : [],
  getProviderEnvVarsImpl: (provider: string) => [`TEST_AUTH_${provider.toUpperCase()}`],
  loadShellEnvFallbackImpl: () => {},
};
const planEntry = (suite: MediaSuiteId, providers: string[] = []): SuiteRunPlan => ({
  suite: MEDIA_SUITES[suite],
  providers,
});
const emptyPlan = () => [{ ...planEntry("image"), skippedReason: "no providers with usable auth" }];
const hostedOptions = (suite: string, ...args: string[]) =>
  parseHostedMediaOptions(["--suite", suite, "--artifact-base", os.tmpdir(), ...args]);

afterEach(() => vi.unstubAllEnvs());

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
    const missingAuth = "no runnable providers matched available auth";
    expect(classifyHostedMediaFailureStatus(missingAuth)).toBe("blocked");
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
    ["--providers unknown", "Unknown provider(s) for selected media suite(s): unknown"],
    ["--image-providers runway", "Unknown image provider(s): runway"],
    ["--music-providers fal", "Provider filter(s) target unselected media suite(s): music"],
  ])("rejects invalid image selection %s", (selection, error) => {
    expect(() => cli(`image ${selection} --all-providers`)).toThrow(error);
  });

  it.each([
    ["image", "openrouter"],
    ["music", "fal,openrouter"],
    ["video", "fal,google,kie,novita,openrouter,pixverse,runway,zai"],
  ] as const)("selects %s providers %s without auth narrowing", async (suite, providers) => {
    const plan = await buildRunPlan(
      cli(`${suite} --${suite}-providers ${providers} --all-providers`),
      planDependencies,
    );
    expect(plan).toMatchObject([{ suite: { id: suite }, providers: providers.split(",") }]);
  });

  it.each([
    [
      "--all-providers --project tooling -- -t media-smoke",
      {
        requireAuth: false,
        passthroughArgs: ["--project", "tooling", "-t", "media-smoke"],
      },
    ],
    ["--quiet --reporter dot", { quietArgs: ["--quiet"], passthroughArgs: ["--reporter", "dot"] }],
  ] as const)("separates CLI flags and Vitest arguments: %s", (args, expected) => {
    expect(cli(`image ${args}`)).toMatchObject({ suites: ["image"], ...expected });
  });

  it.each([
    ["image music --image-providers openai --music-providers minimax", ["music"]],
    ["image music video --providers openai", []],
  ] as const)("reports only explicitly selected suites skipped by auth: %s", (args, expected) => {
    const options = cli(args);
    const plan = options.suites.map((suite) =>
      planEntry(suite, suite === "image" ? ["openai"] : []),
    );
    const skipped = findSkippedExplicitProviderSelections(options, plan);
    expect(skipped.map(({ suite }) => suite.id)).toEqual(expected);
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
});
