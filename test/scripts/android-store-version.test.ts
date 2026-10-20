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
type PlanInput = Parameters<typeof resolveAndroidStorePlan>[0];
const resolve = (changes: Partial<PlanInput>) => resolveAndroidStorePlan({ ...input, ...changes });
const snapshot = (
  tracks: ReturnType<typeof track>[],
  uploadedVersionCodes = input.snapshot.uploadedVersionCodes,
) => ({ uploadedVersionCodes, tracks });
const legacyBaseline = (audience: string, build: string) => ({
  audience,
  build,
  version: "2026.9.4",
  sourceRef: `${prefix}/2026.9.4-2026090401`,
});

describe("Android store version selection", () => {
  it("migrates legacy uploads without changing their public notes identity or reusing either form factor's codes", () => {
    const plan = resolve({
      snapshot: snapshot(
        [track("production", 2026090401), track("wear:production", 2026090451)],
        [
          202603080,
          202603081,
          2026031500,
          2026041590,
          1,
          20260107,
          ...input.snapshot.uploadedVersionCodes,
        ],
      ),
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
        legacyBaseline("phone", "2026090401"),
        legacyBaseline("wear", "2026090451"),
      ],
    });
    expect(resolve({ snapshot: snapshot([], []), refs: [] })).toMatchObject({
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
      resolve({
        gatewayVersion: "2026.9.4",
        snapshot: snapshot([track("production", 2026090401)]),
      }),
    ).toMatchObject({ version: "2026.9.41", revision: 1, buildNumber: 1 });
    expect(
      resolve({
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
    const cases: Array<[Partial<PlanInput>, string]> = [
      [
        {
          refs: [...input.refs, marker],
          snapshot: snapshot([], [2026090501, 2026090502]),
        },
        "no v2 source record",
      ],
      [{ refs: [...input.refs, candidate] }, "no matching legacy cutover"],
      ...[2026090301, 202603080, 2026041590].map((code): [Partial<PlanInput>, string] => [
        { snapshot: snapshot([track("production", code)], [code]) },
        `Google Play production versionCode ${code} has no recorded source identity`,
      ]),
      [{ gatewayVersion: "2026.9.3" }, "precedes"],
      [
        { snapshot: snapshot([track("production", 2026090401, "inProgress")]) },
        "ambiguous public release state",
      ],
      [{ snapshot: snapshot([track("production", 2026090451)]) }, "different form factor"],
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
          snapshot: snapshot([track("production", 2099999999)], []),
        },
        "public revisions for 2026.9.6 are exhausted",
      ],
    ];
    for (const [changes, error] of cases) {
      expect(() => resolve(changes), error).toThrow(error);
    }
  });
});
