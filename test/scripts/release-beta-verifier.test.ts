// Release Beta Verifier tests cover release beta verifier script behavior.
import { describe, expect, it } from "vitest";
import {
  parseNpmViewFields,
  parseReleaseVerifyBetaArgs,
  readBoundedJsonResponse,
  runNpmViewWithRetry,
} from "../../scripts/lib/release-beta-verifier.ts";

describe("parseReleaseVerifyBetaArgs", () => {
  it("defaults beta verification to the matching tag and repo", () => {
    expect(parseReleaseVerifyBetaArgs(["2026.5.10-beta.3"])).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      workflowRef: undefined,
      clawHubWorkflowRef: undefined,
      pluginSelection: [],
      evidenceOut: undefined,
      skipPostpublish: false,
      skipGitHubRelease: false,
      skipClawHub: false,
      rerunFailedClawHub: false,
      workflowRuns: {},
    });
  });

  it("parses child run IDs and repair flags", () => {
    expect(
      parseReleaseVerifyBetaArgs([
        "--",
        "2026.5.10-beta.3",
        "--workflow-ref",
        "release/2026.5.10",
        "--clawhub-workflow-ref",
        "v2026.5.10-beta.3",
        "--plugins",
        "@openclaw/plugin-a,@openclaw/plugin-b",
        "--full-release-validation-run",
        "10",
        "--openclaw-npm-run",
        "11",
        "--plugin-npm-run",
        "22",
        "--plugin-clawhub-run",
        "33",
        "--plugin-clawhub-bootstrap-run",
        "34",
        "--npm-telegram-run",
        "44",
        "--evidence-out",
        ".artifacts/release-evidence.json",
        "--skip-postpublish",
        "--skip-github-release",
        "--skip-clawhub",
        "--rerun-failed-clawhub",
      ]),
    ).toEqual({
      version: "2026.5.10-beta.3",
      tag: "v2026.5.10-beta.3",
      distTag: "beta",
      repo: "openclaw/openclaw",
      registry: "https://clawhub.ai",
      workflowRef: "release/2026.5.10",
      clawHubWorkflowRef: "v2026.5.10-beta.3",
      pluginSelection: ["@openclaw/plugin-a", "@openclaw/plugin-b"],
      evidenceOut: ".artifacts/release-evidence.json",
      skipPostpublish: true,
      skipGitHubRelease: true,
      skipClawHub: true,
      rerunFailedClawHub: true,
      workflowRuns: {
        fullReleaseValidation: "10",
        openclawNpm: "11",
        pluginNpm: "22",
        pluginClawHub: "33",
        pluginClawHubBootstrap: "34",
        npmTelegram: "44",
      },
    });
  });
});

describe("parseNpmViewFields", () => {
  it("accepts keyed npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags.beta": "2026.5.10-beta.3",
          "dist.integrity": "sha512-test",
          "dist.tarball": "https://registry.example/openclaw.tgz",
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });

  it("accepts nested npm view JSON", () => {
    expect(
      parseNpmViewFields(
        JSON.stringify({
          version: "2026.5.10-beta.3",
          "dist-tags": { beta: "2026.5.10-beta.3" },
          dist: {
            integrity: "sha512-test",
            tarball: "https://registry.example/openclaw.tgz",
          },
        }),
        "beta",
      ),
    ).toEqual({
      version: "2026.5.10-beta.3",
      distTagVersion: "2026.5.10-beta.3",
      integrity: "sha512-test",
      tarball: "https://registry.example/openclaw.tgz",
    });
  });
});

describe("runNpmViewWithRetry", () => {
  it("retries transient registry failures with online metadata reads", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];

    await expect(
      runNpmViewWithRetry(["view", "openclaw@2026.5.10-beta.3", "version", "--json"], {
        attempts: 3,
        delay: async (delayMs) => {
          delays.push(delayMs);
        },
        run: (args) => {
          calls.push(args);
          if (calls.length < 3) {
            throw new Error("npm registry has not propagated the release yet");
          }
          return '"2026.5.10-beta.3"';
        },
      }),
    ).resolves.toBe('"2026.5.10-beta.3"');

    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.at(-1) === "--prefer-online")).toBe(true);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("readBoundedJsonResponse", () => {
  it("parses JSON bodies within the release verifier limit", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"ok":true}'), "ClawHub package", 64),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects oversized JSON bodies by content length", async () => {
    await expect(
      readBoundedJsonResponse(
        new Response("{}", { headers: { "content-length": "65" } }),
        "ClawHub package",
        64,
      ),
    ).rejects.toThrow("ClawHub package response body exceeded 64 bytes.");
  });

  it("rejects oversized streamed JSON bodies", async () => {
    await expect(
      readBoundedJsonResponse(new Response('{"padding":"too-large"}'), "ClawHub package", 8),
    ).rejects.toThrow("ClawHub package response body exceeded 8 bytes.");
  });
});
