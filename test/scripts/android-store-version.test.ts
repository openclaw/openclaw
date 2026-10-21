import { expect, it } from "vitest";
import { resolveAndroidStorePlan } from "../../scripts/lib/android-store-version.ts";

const sha = "a".repeat(40);
const prefix = "refs/openclaw/mobile-releases/android";
const ref = (suffix: string) => ({ ref: `${prefix}/${suffix}`, sha });
const codes = [2026090401, 2026090451];
const input = {
  gatewayVersion: "2026.9.6-beta.1",
  pinnedVersion: "2026.8.2",
  pinnedVersionCode: 2026080201,
  sourceSha: sha,
  snapshot: { uploadedVersionCodes: codes, tracks: [] },
  refs: [ref("2026.9.4-2026090401")],
};
const marker = ref("cutover-v2/2026090451");
const candidate = ref("v2/2026.9.6/0/1/2026090452-2026090453");
const track = (name: string, code: number, status = "completed") => ({
  track: name,
  releases: [{ status, versionCodes: [String(code)] }],
});
type PlanInput = Parameters<typeof resolveAndroidStorePlan>[0];
const resolve = (changes: Partial<PlanInput>) => resolveAndroidStorePlan({ ...input, ...changes });
const expectPlan = (changes: Partial<PlanInput>) => expect(resolve(changes));
const snapshot = (tracks: ReturnType<typeof track>[], uploadedVersionCodes = codes) => ({
  uploadedVersionCodes,
  tracks,
});
const legacyBaseline = (audience: string, build: string) => ({
  audience,
  build,
  version: "2026.9.4",
  sourceRef: `${prefix}/2026.9.4-2026090401`,
});
const publicTracks = (phone = 2026090401, wear = 2026090451) => [
  track("production", phone),
  track("wear:production", wear),
];

it("migrates legacy uploads without changing notes identities or reusing codes", () => {
  expectPlan({
    snapshot: snapshot(publicTracks(), [2026041590, ...codes]),
  }).toMatchObject({
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
  expectPlan({ snapshot: snapshot([], []), refs: [] }).toMatchObject({
    versionCode: 2026080252,
    wearVersionCode: 2026080253,
    legacyMaxVersionCode: 0,
  });
});

it("advances candidate revision when phone or Wear is public, with separate baselines", () => {
  const prepared = {
    refs: [...input.refs, marker, candidate],
    snapshot: snapshot(publicTracks(), [...codes, 2026090452, 2026090453]),
  };
  expectPlan(prepared).toMatchObject({
    version: "2026.9.60",
    revision: 0,
    buildNumber: 2,
    versionCode: 2026090454,
    wearVersionCode: 2026090455,
  });
  for (const audience of ["phone", "wear"]) {
    const plan = resolve({
      ...prepared,
      snapshot: snapshot(
        publicTracks(
          audience === "phone" ? 2026090452 : 2026090401,
          audience === "wear" ? 2026090453 : 2026090451,
        ),
        prepared.snapshot.uploadedVersionCodes,
      ),
    });
    expect(plan).toMatchObject({ version: "2026.9.61", revision: 1, buildNumber: 1 });
    expect(
      plan.releaseNotesBaselines.find((baseline) => baseline.audience === audience),
    ).toMatchObject({ version: "2026.9.60", sourceRef: candidate.ref });
  }
  // Recorded uploads remain a high-water mark when they disappear from Play's current inventory.
  expectPlan({ ...prepared, snapshot: input.snapshot }).toMatchObject({
    versionCode: 2026090454,
    buildNumber: 2,
  });
});

it("increments legacy public revision zero and resets for a newer Gateway patch", () => {
  expectPlan({
    gatewayVersion: "2026.9.4",
    snapshot: snapshot([track("production", 2026090401)]),
  }).toMatchObject({ version: "2026.9.41", revision: 1, buildNumber: 1 });
  expectPlan({
    gatewayVersion: "2026.9.100",
    refs: [...input.refs, marker, candidate],
  }).toMatchObject({
    version: "2026.9.1000",
    revision: 0,
    buildNumber: 1,
    versionCode: 2026090454,
  });
});

it("refuses ambiguous identities, rollouts, downgrades, and exhausted store versions", () => {
  const final = ref("v2/2026.9.6/9/1/2099999999-2100000000");
  const rejects = (changes: Partial<PlanInput>, error: string) =>
    expect(() => resolve(changes), error).toThrow(error);
  rejects(
    { refs: [...input.refs, marker], snapshot: snapshot([], [2026090501, 2026090502]) },
    "no v2 source record",
  );
  rejects({ refs: [...input.refs, candidate] }, "no matching legacy cutover");
  rejects(
    { snapshot: snapshot([track("production", 2026090301)], [2026090301]) },
    "Google Play production versionCode 2026090301 has no recorded source identity",
  );
  rejects({ gatewayVersion: "2026.9.3" }, "precedes");
  rejects(
    { snapshot: snapshot([track("production", 2026090401, "inProgress")]) },
    "ambiguous public release state",
  );
  rejects({ snapshot: snapshot([track("production", 2026090451)]) }, "different form factor");
  rejects(
    { refs: [...input.refs, marker, candidate, ref("v2/2026.9.6/1/1/2026090452-2026090453")] },
    "Multiple Android source records",
  );
  rejects(
    { refs: [marker, ref("cutover-v2/2026090453")] },
    "Multiple Android store version cutover",
  );
  rejects({ refs: [marker, final] }, "versionCode space is exhausted");
  rejects(
    { refs: [marker, final], snapshot: snapshot([track("production", 2099999999)], []) },
    "public revisions for 2026.9.6 are exhausted",
  );
});
