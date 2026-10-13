import { describe, expect, it } from "vitest";
import { resolveAndroidStorePlan } from "../../scripts/lib/android-store-version.ts";

const sha = "a".repeat(40);
const prefix = "refs/openclaw/mobile-releases/android";
const input = {
  gatewayVersion: "2026.9.6-beta.1",
  pinnedVersion: "2026.8.2",
  pinnedVersionCode: 2026080201,
  sourceSha: sha,
  snapshot: { uploadedVersionCodes: [2026090401, 2026090451], tracks: [] },
  refs: [{ ref: `${prefix}/2026.9.4-2026090401`, sha }],
};
const marker = { ref: `${prefix}/cutover-v2/2026090451`, sha };
const candidate = { ref: `${prefix}/v2/2026.9.6/0/1/2026090452-2026090453`, sha };
const track = (name: string, code: number, status = "completed") => ({
  track: name,
  releases: [{ status, versionCodes: [String(code)] }],
});

describe("Android store version selection", () => {
  it("migrates legacy uploads without changing their public notes identity or reusing either form factor's codes", () => {
    const plan = resolveAndroidStorePlan({
      ...input,
      snapshot: {
        ...input.snapshot,
        uploadedVersionCodes: [
          202603080,
          202603081,
          2026031500,
          2026041590,
          1,
          20260107,
          ...input.snapshot.uploadedVersionCodes,
        ],
        tracks: [track("production", 2026090401), track("wear:production", 2026090451)],
      },
    });
    expect(plan).toMatchObject({
      schemaVersion: 2,
      gatewayVersion: "2026.9.6",
      revision: 0,
      buildNumber: 1,
      version: "2026.9.60",
      versionCode: 2026090452,
      wearVersionCode: 2026090453,
      legacyMaxVersionCode: 2026090451,
      releaseNotesBaselines: [
        {
          audience: "phone",
          version: "2026.9.4",
          build: "2026090401",
          sourceRef: `${prefix}/2026.9.4-2026090401`,
        },
        {
          audience: "wear",
          version: "2026.9.4",
          build: "2026090451",
          sourceRef: `${prefix}/2026.9.4-2026090401`,
        },
      ],
    });
    expect(
      resolveAndroidStorePlan({
        ...input,
        snapshot: { uploadedVersionCodes: [], tracks: [] },
        refs: [],
      }),
    ).toMatchObject({
      versionCode: 2026080252,
      wearVersionCode: 2026080253,
      legacyMaxVersionCode: 0,
    });
  });

  it("reuses a candidate revision, then advances it when either phone or Wear is public, retaining separate baselines", () => {
    const prepared = {
      ...input,
      refs: [...input.refs, marker, candidate],
      snapshot: {
        uploadedVersionCodes: [...input.snapshot.uploadedVersionCodes, 2026090452, 2026090453],
        tracks: [track("production", 2026090401), track("wear:production", 2026090451)],
      },
    };
    expect(resolveAndroidStorePlan(prepared)).toMatchObject({
      version: "2026.9.60",
      revision: 0,
      buildNumber: 2,
      versionCode: 2026090454,
      wearVersionCode: 2026090455,
    });
    for (const audience of ["phone", "wear"]) {
      const plan = resolveAndroidStorePlan({
        ...prepared,
        snapshot: {
          ...prepared.snapshot,
          tracks: [
            track("production", audience === "phone" ? 2026090452 : 2026090401),
            track("wear:production", audience === "wear" ? 2026090453 : 2026090451),
          ],
        },
      });
      expect(plan).toMatchObject({ version: "2026.9.61", revision: 1, buildNumber: 1 });
      expect(
        plan.releaseNotesBaselines.find((baseline) => baseline.audience === audience),
      ).toMatchObject({ version: "2026.9.60", sourceRef: candidate.ref });
    }
    // Recorded uploads remain a high-water mark when they disappear from Play's current inventory.
    expect(resolveAndroidStorePlan({ ...prepared, snapshot: input.snapshot })).toMatchObject({
      versionCode: 2026090454,
      buildNumber: 2,
    });
  });

  it("treats an exact legacy public release as revision zero and resets for a newer Gateway patch", () => {
    expect(
      resolveAndroidStorePlan({
        ...input,
        gatewayVersion: "2026.9.4",
        snapshot: {
          ...input.snapshot,
          tracks: [track("production", 2026090401)],
        },
      }),
    ).toMatchObject({ version: "2026.9.41", revision: 1, buildNumber: 1 });
    expect(
      resolveAndroidStorePlan({
        ...input,
        gatewayVersion: "2026.9.100",
        refs: [...input.refs, marker, candidate],
      }),
    ).toMatchObject({
      version: "2026.9.1000",
      revision: 0,
      buildNumber: 1,
      versionCode: 2026090454,
    });
  });

  it("refuses ambiguous identities, rollouts, downgrades, and exhausted store versions", () => {
    const final = { ref: `${prefix}/v2/2026.9.6/9/1/2099999999-2100000000`, sha };
    const cases: Array<[Partial<Parameters<typeof resolveAndroidStorePlan>[0]>, string]> = [
      [
        {
          refs: [...input.refs, marker],
          snapshot: { uploadedVersionCodes: [2026090501, 2026090502], tracks: [] },
        },
        "no v2 source record",
      ],
      [{ refs: [...input.refs, candidate] }, "no matching legacy cutover"],
      ...[2026090301, 202603080, 2026041590].map(
        (code): [Partial<Parameters<typeof resolveAndroidStorePlan>[0]>, string] => [
          { snapshot: { uploadedVersionCodes: [code], tracks: [track("production", code)] } },
          `Google Play production versionCode ${code} has no recorded source identity`,
        ],
      ),
      [{ gatewayVersion: "2026.9.3" }, "precedes"],
      [
        {
          snapshot: { ...input.snapshot, tracks: [track("production", 2026090401, "inProgress")] },
        },
        "ambiguous public release state",
      ],
      [
        { snapshot: { ...input.snapshot, tracks: [track("production", 2026090451)] } },
        "different form factor",
      ],
      [
        {
          refs: [
            ...input.refs,
            marker,
            candidate,
            { ref: `${prefix}/v2/2026.9.6/1/1/2026090452-2026090453`, sha },
          ],
        },
        "Multiple Android source records",
      ],
      [
        { refs: [marker, { ref: `${prefix}/cutover-v2/2026090453`, sha }] },
        "Multiple Android store version cutover",
      ],
      [{ refs: [marker, final] }, "versionCode space is exhausted"],
      [
        {
          refs: [marker, final],
          snapshot: { uploadedVersionCodes: [], tracks: [track("production", 2099999999)] },
        },
        "public revisions for 2026.9.6 are exhausted",
      ],
    ];
    for (const [changes, error] of cases) {
      expect(() => resolveAndroidStorePlan({ ...input, ...changes }), error).toThrow(error);
    }
  });
});
