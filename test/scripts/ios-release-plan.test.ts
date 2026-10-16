import { describe, expect, it } from "vitest";
import {
  cutIosReleaseChangelog,
  decodeIosAppStoreVersion,
  resolveIosReleasePlan,
  type IosReleasePlanInput,
} from "../../scripts/lib/ios-release-plan.ts";

function input(overrides: Partial<IosReleasePlanInput> = {}): IosReleasePlanInput {
  const publicVersion =
    overrides.appStoreVersions?.find((version) => version.state === "READY_FOR_DISTRIBUTION")
      ?.versionString ?? null;
  return {
    appStoreVersions: [],
    buildUploads: [],
    gatewayVersion: "2026.7.2",
    releaseNotesBaselines: [
      { audience: "ios", version: publicVersion, build: publicVersion ? "5" : null },
    ],
    ...overrides,
  };
}
const version = (id: string, state: string, versionString: string) => ({
  id,
  state,
  versionString,
});
const upload = (buildNumber: string, shortVersion: string, state: string) => ({
  buildNumber,
  shortVersion,
  state,
});
const legacy = version("legacy", "READY_FOR_DISTRIBUTION", "2026.7.2");
type PlanCase = [
  string,
  Partial<IosReleasePlanInput>,
  Partial<ReturnType<typeof resolveIosReleasePlan>>,
];
type InvalidPlanCase = [string, Partial<IosReleasePlanInput>, string | RegExp];

describe("resolveIosReleasePlan", () => {
  it.each<PlanCase>([
    [
      "new gateway",
      {},
      {
        destination: "app-store",
        appStoreRevision: 0,
        appStoreVersion: "2026.7.20",
        buildNumber: 1,
        releaseNotesBaselines: [{ audience: "ios", version: null, build: null }],
        decision: "new-revision",
      },
    ],
    [
      "legacy released revision",
      { appStoreVersions: [legacy] },
      {
        appStoreRevision: 1,
        appStoreVersion: "2026.7.21",
        buildNumber: 1,
        decision: "new-revision",
      },
    ],
    [
      "legacy upload-only revision",
      { buildUploads: [upload("4", "2026.7.2", "COMPLETE")] },
      {
        appStoreRevision: 1,
        appStoreVersion: "2026.7.21",
        buildNumber: 1,
        decision: "new-revision",
      },
    ],
    [
      "editable revision",
      { appStoreVersions: [version("editable", "PREPARE_FOR_SUBMISSION", "2026.7.21")] },
      {
        appStoreRevision: 1,
        appStoreVersionId: "editable",
        appStoreVersionState: "PREPARE_FOR_SUBMISSION",
        decision: "resume-editable",
      },
    ],
    [
      "TestFlight alongside a matching App Store revision",
      {
        destination: "testflight",
        appStoreVersions: [
          version("public", "READY_FOR_DISTRIBUTION", "2026.7.20"),
          version("store", "IN_REVIEW", "2026.7.21"),
        ],
        buildUploads: [upload("7", "2026.7.21", "FAILED"), upload("90", "2026.7.20", "COMPLETE")],
      },
      {
        destination: "testflight",
        appStoreRevision: 1,
        appStoreVersion: "2026.7.21",
        appStoreVersionId: null,
        appStoreVersionState: null,
        buildNumber: 8,
        decision: "resume-testflight",
        releaseNotesBaselines: [{ audience: "ios", version: "2026.7.20", build: "5" }],
      },
    ],
    [
      "TestFlight alongside another gateway's App Store revision",
      {
        destination: "testflight",
        appStoreVersions: [version("other", "IN_REVIEW", "2026.7.30")],
        buildUploads: [
          upload("4", "2026.7.20", "PROCESSING"),
          upload("90", "2026.7.30", "COMPLETE"),
        ],
      },
      {
        destination: "testflight",
        appStoreRevision: 0,
        appStoreVersion: "2026.7.20",
        appStoreVersionId: null,
        appStoreVersionState: null,
        buildNumber: 5,
        decision: "retry-upload",
      },
    ],
    ...["FAILED", "AWAITING_UPLOAD"].map<PlanCase>((state) => [
      `uploaded revision after removing its version record (${state})`,
      {
        appStoreVersions: [legacy],
        buildUploads: [upload("1", "2026.7.21", state)],
      },
      { appStoreRevision: 1, buildNumber: 2, decision: "retry-upload" },
    ]),
    [
      "next build after a failed upload",
      {
        appStoreVersions: [version("editable", "READY_FOR_REVIEW", "2026.7.21")],
        buildUploads: [upload("7", "2026.7.21", "FAILED"), upload("3", "2026.7.21", "COMPLETE")],
      },
      { buildNumber: 8 },
    ],
    [
      "an appended version is not a future gateway's legacy release",
      {
        appStoreVersions: [version("older", "READY_FOR_DISTRIBUTION", "2026.7.21")],
        gatewayVersion: "2026.7.21",
      },
      { appStoreRevision: 0, appStoreVersion: "2026.7.210", decision: "new-revision" },
    ],
    [
      "public notes baseline stays independent of candidate uploads",
      {
        appStoreVersions: [legacy, version("editable", "PREPARE_FOR_SUBMISSION", "2026.7.21")],
        buildUploads: [upload("19", "2026.7.21", "COMPLETE")],
        releaseNotesBaselines: [{ audience: "ios", version: "2026.7.2", build: "3" }],
      },
      {
        buildNumber: 20,
        releaseNotesBaselines: [{ audience: "ios", version: "2026.7.2", build: "3" }],
      },
    ],
  ])("plans %s", (_name, overrides, expected) => {
    const plan = resolveIosReleasePlan(input(overrides));
    expect(plan).toMatchObject(expected);
    if (expected.releaseNotesBaselines) {
      expect(plan.releaseNotesBaselines).toEqual(expected.releaseNotesBaselines);
    }
  });

  it.each<InvalidPlanCase>([
    [
      "ambiguous TestFlight revisions",
      {
        destination: "testflight",
        appStoreVersions: [version("store", "PREPARE_FOR_SUBMISSION", "2026.7.21")],
        buildUploads: [upload("4", "2026.7.22", "COMPLETE")],
      },
      "Multiple unreleased TestFlight revisions",
    ],
    [
      "multiple upload-only unreleased revisions",
      {
        appStoreVersions: [legacy],
        buildUploads: [upload("1", "2026.7.21", "FAILED"), upload("1", "2026.7.22", "FAILED")],
      },
      "Multiple unreleased App Store build-upload revisions",
    ],
    [
      "locked active version",
      { appStoreVersions: [version("locked", "IN_REVIEW", "2026.7.21")] },
      "locked in state IN_REVIEW",
    ],
    [
      "mismatched active version",
      { appStoreVersions: [version("other", "PREPARE_FOR_SUBMISSION", "2026.7.30")] },
      "does not belong to gateway 2026.7.2",
    ],
    ...(["app-store", "testflight"] as const).map((destination): InvalidPlanCase => [
      `multiple active ${destination} versions`,
      {
        destination,
        appStoreVersions: [
          version("one", "PREPARE_FOR_SUBMISSION", "2026.7.21"),
          version("two", "READY_FOR_REVIEW", "2026.7.22"),
        ],
      },
      "multiple active iOS versions",
    ]),
    [
      "unknown upload state",
      { buildUploads: [upload("1", "2026.7.20", "NEW_APPLE_STATE")] },
      "Unknown App Store build upload state",
    ],
    [
      "exhausted revisions",
      { appStoreVersions: [version("last", "READY_FOR_DISTRIBUTION", "2026.7.29")] },
      "exhausted App Store revisions 0 through 9",
    ],
    [
      "planned version older than another gateway's released history",
      { appStoreVersions: [legacy], gatewayVersion: "2026.6.11" },
      "must be greater than latest released version 2026.7.2",
    ],
    [
      "explicit revision mismatch",
      { explicitRevision: 4 },
      "does not match the planned revision 0",
    ],
    [
      "explicit build mismatch",
      { explicitBuildNumber: "4" },
      "does not match the planned next build 1",
    ],
    ...[
      { version: null, build: null },
      { version: "2026.7.2", build: null },
      { version: "2026.7.21", build: "3" },
      { version: "2026.7.2", build: "unknown" },
    ].map((baseline): InvalidPlanCase => [
      `unresolvable public notes baseline ${JSON.stringify(baseline)}`,
      { appStoreVersions: [legacy], releaseNotesBaselines: [{ audience: "ios", ...baseline }] },
      /baseline|build number/,
    ]),
  ])("rejects %s", (_name, overrides, error) => {
    expect(() => resolveIosReleasePlan(input(overrides))).toThrow(error);
  });

  it("decodes only legacy or single-digit revision versions for the selected gateway", () => {
    const cases: Array<[string, string, ReturnType<typeof decodeIosAppStoreVersion>]> = [
      ["2026.7.2", "2026.7.2", { legacy: true, revision: 0 }],
      ["2026.7.2", "2026.7.20", { legacy: false, revision: 0 }],
      ["2026.7.2", "2026.7.21", { legacy: false, revision: 1 }],
      ["2026.7.2", "2026.7.29", { legacy: false, revision: 9 }],
      ["2026.7.2", "2026.7.201", null],
      ["2026.7.2", "2026.7.30", null],
      ["2026.7.3", "2026.7.3", null],
      ["2026.7.21", "2026.7.21", null],
      ["2026.7.21", "2026.7.210", { legacy: false, revision: 0 }],
    ];
    for (const [gateway, candidate, expected] of cases) {
      expect(decodeIosAppStoreVersion(gateway, candidate)).toEqual(expected);
    }
  });
});

it.each([
  [
    "new release",
    "New notes.",
    "2026.7.2",
    "Old notes.",
    ["## Unreleased\n\n## 2026.7.21\n\nNew notes.", "## 2026.7.2\n\nOld notes."],
  ],
  [
    "retry",
    "Retry fix.",
    "2026.7.21",
    "Original notes.",
    ["## 2026.7.21\n\nRetry fix.\n\nOriginal notes."],
  ],
  [
    "heading suffix",
    "Retry fix.",
    "2026.7.21 - 2026-07-23",
    "Original notes.",
    ["## 2026.7.21 - 2026-07-23\n\nRetry fix.\n\nOriginal notes."],
  ],
] as const)("cuts idempotent release notes for %s", (_name, notes, heading, oldNotes, expected) => {
  const current = `# OpenClaw iOS Changelog\n\n## Unreleased\n\n${notes}\n\n## ${heading}\n\n${oldNotes}\n`;
  const updated = cutIosReleaseChangelog(current, "2026.7.21");
  for (const fragment of expected) {
    expect(updated).toContain(fragment);
  }
  expect(cutIosReleaseChangelog(updated, "2026.7.21")).toBe(updated);
});
