import { expect, it } from "vitest";
import {
  cutIosReleaseChangelog,
  resolveIosReleasePlan,
  type IosReleasePlanInput,
} from "../../scripts/lib/ios-release-plan.ts";

function input(overrides: Partial<IosReleasePlanInput> = {}): IosReleasePlanInput {
  const published =
    overrides.appStoreVersions?.find((version) => version.state === "READY_FOR_DISTRIBUTION")
      ?.versionString ?? null;
  return {
    appStoreVersions: [],
    buildUploads: [],
    gatewayVersion: "2026.7.2",
    releaseNotesBaselines: [{ audience: "ios", version: published, build: published ? "5" : null }],
    ...overrides,
  };
}
const version = (id: string, state: string, v = "2026.7.21") => ({ id, state, versionString: v });
const upload = (buildNumber: string, shortVersion: string, state: string) => ({
  buildNumber,
  shortVersion,
  state,
});
const legacy = version("legacy", "READY_FOR_DISTRIBUTION", "2026.7.2");
const editable = version("editable", "READY_FOR_REVIEW");
const store = (...appStoreVersions: ReturnType<typeof version>[]) => ({ appStoreVersions });
type PlanCase = [Partial<IosReleasePlanInput>, Partial<ReturnType<typeof resolveIosReleasePlan>>];
type InvalidPlanCase = [Partial<IosReleasePlanInput>, string | RegExp];
const newRevision = {
  appStoreRevision: 1,
  appStoreVersion: "2026.7.21",
  buildNumber: 1,
  decision: "new-revision",
} as const;
const revisionZero = { appStoreRevision: 0, appStoreVersion: "2026.7.20" };

it.each<PlanCase>([
  [
    {},
    {
      ...newRevision,
      ...revisionZero,
      destination: "app-store",
      releaseNotesBaselines: [{ audience: "ios", version: null, build: null }],
    },
  ],
  [store(legacy), newRevision],
  [{ buildUploads: [upload("4", "2026.7.2", "COMPLETE")] }, newRevision],
  [
    {
      destination: "testflight",
      appStoreVersions: [
        version("public", "READY_FOR_DISTRIBUTION", "2026.7.20"),
        version("store", "IN_REVIEW"),
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
    {
      destination: "testflight",
      appStoreVersions: [version("other", "IN_REVIEW", "2026.7.30")],
      buildUploads: [upload("4", "2026.7.20", "PROCESSING"), upload("90", "2026.7.30", "COMPLETE")],
    },
    {
      destination: "testflight",
      ...revisionZero,
      appStoreVersionId: null,
      appStoreVersionState: null,
      buildNumber: 5,
      decision: "retry-upload",
    },
  ],
  [
    {
      appStoreVersions: [legacy],
      buildUploads: [upload("1", "2026.7.21", "FAILED")],
    },
    { appStoreRevision: 1, buildNumber: 2, decision: "retry-upload" },
  ],
  [
    {
      appStoreVersions: [version("older", "READY_FOR_DISTRIBUTION")],
      gatewayVersion: "2026.7.21",
    },
    { appStoreRevision: 0, appStoreVersion: "2026.7.210", decision: "new-revision" },
  ],
  [
    {
      ...store(legacy, editable),
      buildUploads: [upload("19", "2026.7.21", "FAILED"), upload("3", "2026.7.21", "COMPLETE")],
      releaseNotesBaselines: [{ audience: "ios", version: "2026.7.2", build: "3" }],
    },
    {
      buildNumber: 20,
      appStoreRevision: 1,
      appStoreVersionId: "editable",
      appStoreVersionState: "READY_FOR_REVIEW",
      decision: "resume-editable",
      releaseNotesBaselines: [{ audience: "ios", version: "2026.7.2", build: "3" }],
    },
  ],
])("plans %j", (overrides, expected) => {
  const plan = resolveIosReleasePlan(input(overrides));
  expect(plan).toMatchObject(expected);
  if (expected.releaseNotesBaselines) {
    expect(plan.releaseNotesBaselines).toEqual(expected.releaseNotesBaselines);
  }
});

it.each<InvalidPlanCase>([
  [
    {
      destination: "testflight",
      appStoreVersions: [version("store", "PREPARE_FOR_SUBMISSION")],
      buildUploads: [upload("4", "2026.7.22", "COMPLETE")],
    },
    "Multiple unreleased TestFlight revisions",
  ],
  [
    {
      appStoreVersions: [legacy],
      buildUploads: [upload("1", "2026.7.21", "FAILED"), upload("1", "2026.7.22", "FAILED")],
    },
    "Multiple unreleased App Store build-upload revisions",
  ],
  [store(version("locked", "IN_REVIEW")), "locked in state IN_REVIEW"],
  [
    store(version("other", "PREPARE_FOR_SUBMISSION", "2026.7.30")),
    "does not belong to gateway 2026.7.2",
  ],
  [
    store(version("invalid-revision", "PREPARE_FOR_SUBMISSION", "2026.7.201")),
    "does not belong to gateway 2026.7.2",
  ],
  ...(["app-store", "testflight"] as const).map((destination): InvalidPlanCase => [
    {
      destination,
      appStoreVersions: [
        version("one", "PREPARE_FOR_SUBMISSION"),
        version("two", "READY_FOR_REVIEW", "2026.7.22"),
      ],
    },
    "multiple active iOS versions",
  ]),
  [
    { buildUploads: [upload("1", "2026.7.20", "NEW_APPLE_STATE")] },
    "Unknown App Store build upload state",
  ],
  [
    store(version("last", "READY_FOR_DISTRIBUTION", "2026.7.29")),
    "exhausted App Store revisions 0 through 9",
  ],
  [
    { ...store(legacy), gatewayVersion: "2026.6.11" },
    "must be greater than latest released version 2026.7.2",
  ],
  [{ explicitRevision: 4 }, "does not match the planned revision 0"],
  [{ explicitBuildNumber: "4" }, "does not match the planned next build 1"],
  ...[
    { version: null, build: null },
    { version: "2026.7.2", build: null },
    { version: "2026.7.21", build: "3" },
    { version: "2026.7.2", build: "unknown" },
  ].map((baseline): InvalidPlanCase => [
    { appStoreVersions: [legacy], releaseNotesBaselines: [{ audience: "ios", ...baseline }] },
    /baseline|build number/,
  ]),
])("rejects %j", (overrides, error) => {
  expect(() => resolveIosReleasePlan(input(overrides))).toThrow(error);
});

it.each([
  ["2026.7.2", ["## Unreleased\n\n## 2026.7.21\n\nNew notes.", "## 2026.7.2\n\nOld notes."]],
  ["2026.7.21", ["## 2026.7.21\n\nNew notes.\n\nOld notes."]],
  ["2026.7.21 - 2026-07-23", ["## 2026.7.21 - 2026-07-23\n\nNew notes.\n\nOld notes."]],
] as const)("cuts idempotent release notes for %s", (heading, expected) => {
  const current = `# OpenClaw iOS Changelog\n\n## Unreleased\n\nNew notes.\n\n## ${heading}\n\nOld notes.\n`;
  const updated = cutIosReleaseChangelog(current, "2026.7.21");
  for (const fragment of expected) {
    expect(updated).toContain(fragment);
  }
  expect(cutIosReleaseChangelog(updated, "2026.7.21")).toBe(updated);
});
