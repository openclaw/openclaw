// Test Live Media tests cover test live media script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  MEDIA_SUITES,
  findSkippedExplicitProviderSelections,
  parseArgs,
  runCli,
} from "../../scripts/test-live-media.ts";

describe("scripts/test-live-media", () => {
  it("prints help through the real node --import tsx entrypoint", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-live-media.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Media live harness");
    expect(result.stdout).toContain("pnpm test:live:media");
    expect(result.stderr).toBe("");
  });

  it("rejects unknown global providers for the selected suites", () => {
    expect(() =>
      parseArgs(["image", "--providers", "definitely-not-a-provider", "--all-providers"]),
    ).toThrow("Unknown provider(s) for selected media suite(s): definitely-not-a-provider");
  });

  it("rejects unknown suite-specific providers", () => {
    expect(() => parseArgs(["image", "--image-providers", "runway", "--all-providers"])).toThrow(
      "Unknown image provider(s): runway",
    );
  });

  it("accepts providers supported by the wrapped live suites", () => {
    expect(
      parseArgs(["image", "--image-providers", "openrouter", "--all-providers"]).suiteProviders
        .image,
    ).toEqual(new Set(["openrouter"]));
    expect(
      parseArgs(["music", "--music-providers", "fal,openrouter", "--all-providers"]).suiteProviders
        .music,
    ).toEqual(new Set(["fal", "openrouter"]));
    expect(
      parseArgs(["video", "--video-providers", "openrouter", "--all-providers"]).suiteProviders
        .video,
    ).toEqual(new Set(["openrouter"]));
  });

  it("rejects suite-specific provider filters for unselected suites", () => {
    expect(() => parseArgs(["image", "--music-providers", "fal", "--all-providers"])).toThrow(
      "Provider filter(s) target unselected media suite(s): music",
    );
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

  it("parses the explicit empty-run escape hatch", () => {
    expect(parseArgs(["--allow-empty"])).toMatchObject({
      allowEmpty: true,
      requireAuth: true,
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
      { suite: MEDIA_SUITES.video, providers: ["openai"] },
    ]);

    expect(skipped).toEqual([]);
  });

  it("fails default live media runs when auth filtering leaves no providers", async () => {
    await expect(
      runCli(["image"], {
        buildRunPlanImpl: () => [
          {
            providers: [],
            skippedReason: "no providers with usable auth",
            suite: MEDIA_SUITES.image,
          },
        ],
      }),
    ).resolves.toBe(1);
  });

  it("allows empty live media runs only with an explicit escape hatch", async () => {
    await expect(
      runCli(["image", "--allow-empty"], {
        buildRunPlanImpl: () => [
          {
            providers: [],
            skippedReason: "no providers with usable auth",
            suite: MEDIA_SUITES.image,
          },
        ],
      }),
    ).resolves.toBe(0);
  });
});
