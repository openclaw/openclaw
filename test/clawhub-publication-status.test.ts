import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectClawHubPublicationStatus,
  parseClawHubPublicationStatusArgs,
  summarizeClawHubPublicationStatus,
} from "../scripts/clawhub-publication-status.mts";
import { writePublishablePluginFixture } from "./helpers/publishable-plugin-fixture.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";
import { commit, initGit } from "./scripts/mobile-release-git.test-support.js";

const version = "2026.11.5-beta.1";
const observedAt = "2026-11-04T05:22:00.000Z";
const tempDirs: string[] = [];

afterEach(() => cleanupTempDirs(tempDirs));

describe("ClawHub publication status", () => {
  it("reports each public lifecycle stage and failed package names", () => {
    const summary = summarizeClawHubPublicationStatus(
      [
        { name: "@openclaw/public", publication: { state: "published" } },
        { name: "@openclaw/missing", publication: { state: "absent" } },
        { name: "@openclaw/staging", publication: { state: "pending", stage: "staging" } },
        {
          name: "@openclaw/checks",
          publication: { state: "pending", stage: "checks", attemptId: "attempt-checks" },
        },
        {
          name: "@openclaw/finalizing",
          publication: {
            state: "pending",
            stage: "finalization",
            attemptId: "attempt-finalizing",
          },
        },
        {
          name: "@openclaw/failed",
          publication: { state: "failed", recoverable: true, attemptId: "attempt-failed" },
        },
      ],
      { version, observedAt },
    );

    expect(summary.counts).toEqual({
      total: 6,
      published: 1,
      absent: 1,
      pending: 3,
      staging: 1,
      checks: 1,
      finalization: 1,
      failed: 1,
    });
    expect(summary.pendingNames).toEqual({
      staging: ["@openclaw/staging"],
      checks: ["@openclaw/checks"],
      finalization: ["@openclaw/finalizing"],
    });
    expect(summary.failedNames).toEqual(["@openclaw/failed"]);
    expect(summary.stalled).toBeNull();
  });

  it("marks pending packages stalled only after the explicit no-progress threshold", () => {
    const pending = [
      {
        name: "@openclaw/diffs",
        publication: {
          state: "pending" as const,
          stage: "finalization" as const,
          attemptId: "attempt-diffs",
        },
      },
    ];
    const before = summarizeClawHubPublicationStatus(pending, {
      version,
      observedAt,
      lastProgressAt: "2026-11-04T04:37:00.000Z",
      stallThresholdMinutes: 60,
    });
    const after = summarizeClawHubPublicationStatus(pending, {
      version,
      observedAt,
      lastProgressAt: "2026-11-04T04:21:59.000Z",
      stallThresholdMinutes: 60,
    });

    expect(before).toMatchObject({ stalled: false, stalledNames: [] });
    expect(after).toMatchObject({ stalled: true, stalledNames: ["@openclaw/diffs"] });
  });

  it("rejects same-version roster drift after the release tag", async () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-clawhub-status-");
    initGit(rootDir, { name: "ClawHub Test", email: "clawhub@example.com" });
    writePublishablePluginFixture(rootDir, { version, publishTo: "clawhub" });
    commit(rootDir, "release roster");
    execFileSync("git", ["tag", `v${version}`], { cwd: rootDir });
    writePublishablePluginFixture(rootDir, {
      extensionId: "added-later",
      version,
      publishTo: "clawhub",
    });
    const collect = () =>
      collectClawHubPublicationStatus(parseClawHubPublicationStatusArgs(["--version", version]), {
        rootDir,
        readPublication: async () => ({ state: "absent" as const }),
      });

    await expect(collect()).rejects.toThrow("requires a clean extensions tree");
    commit(rootDir, "same-version roster drift");
    await expect(collect()).rejects.toThrow("Check out the exact release tag");
  });

  it.each(["November 4, 2026 04:37 UTC", "2026-11-04", "2026-02-30T04:37:00Z"])(
    "rejects non-ISO last-progress input: %s",
    (lastProgressAt) => {
      expect(() =>
        parseClawHubPublicationStatusArgs([
          "--version",
          version,
          "--last-progress-at",
          lastProgressAt,
        ]),
      ).toThrow("must be an ISO-8601 timestamp");
    },
  );

  it("rejects a last-progress timestamp after the observation", () => {
    expect(() =>
      summarizeClawHubPublicationStatus([], {
        version,
        observedAt,
        lastProgressAt: "2026-11-04T05:22:01.000Z",
      }),
    ).toThrow("must not be after the observation time");
  });

  it("accepts ISO-8601 timestamps with sub-millisecond precision", () => {
    expect(
      parseClawHubPublicationStatusArgs([
        "--version",
        version,
        "--last-progress-at",
        "2026-11-04T04:37:00.123456789Z",
      ]).lastProgressAt,
    ).toBe("2026-11-04T04:37:00.123Z");
  });

  it("parses a selected read-only observation with the default threshold", () => {
    expect(
      parseClawHubPublicationStatusArgs([
        "--version",
        version,
        "--plugins",
        "@openclaw/diffs, @openclaw/acpx",
        "--last-progress-at",
        "2026-11-04T04:37:00Z",
        "--json",
      ]),
    ).toEqual({
      json: true,
      lastProgressAt: "2026-11-04T04:37:00.000Z",
      plugins: ["@openclaw/acpx", "@openclaw/diffs"],
      stallThresholdMinutes: 60,
      version,
    });
  });
});
