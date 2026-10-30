import { afterEach, expect, it } from "vitest";
import { createPluginNpmPublicationReadback } from "../../scripts/plugin-npm-publication-readback.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createNpmPublicationReadbackFixture,
  packageName,
  version,
} from "./plugin-npm-publication-readback.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function fixture(mode = "direct", fault = "none", distTagVersion?: string) {
  const value = await createNpmPublicationReadbackFixture(
    tempDirs.make("npm-parent-readback-"),
    mode,
    fault,
    distTagVersion,
  );
  const parent = await createPluginNpmPublicationReadback(value.options);
  return { ...value, ...parent };
}

it("rejects missing planning jobs", async () => {
  await expect(fixture("direct", "empty-jobs")).rejects.toThrow("successful planning job");
});

it("verifies already-published registry bytes alongside qualified publishers in a mixed roster", async () => {
  const parent = await fixture("direct", "existing-package");
  await expect(parent.verify("@openclaw/existing", version, "beta")).resolves.toBeUndefined();
  await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
});

it.each([
  "prepared",
  "retained-qualification",
  "retained-publisher",
  "retained-plan",
  "replanned-failed",
])("verifies exact qualified bytes through the %s producer binding", async (mode) => {
  const parent = await fixture(mode);
  await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
  expect(parent.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
  expect(parent.evidence).toMatchObject([
    {
      producerRunId: parent.producerId,
      producerRunAttempt: parent.producerAttempt,
      publisherAttempt: parent.publisherAttempt,
      artifactId: 41,
    },
  ]);
});

it.each([
  ["direct", "missing-receipt", "Expected one consumed"],
  ["direct", "conflicting-bytes", "bytes differ"],
  ["direct", "archive-identity", "qualified artifact"],
  ["direct", "source", "approved package or source"],
  ["direct", "attempt", "producer-attempt binding"],
  ["direct", "artifact", "immutable publication tuple"],
  ["direct", "none", "release version", version, "2026.9.2-beta.2"],
  ["direct", "no-publish", "differs from the prepared version", "2026.9.1-beta.1"],
  ["direct", "none", "differs from the prepared version", "2026.9.2-beta.2"],
  ["replanned-failed", "missing-upload-step", "producer step"],
  ["replanned-failed", "failed-upload-step", "producer step"],
  ["replanned-failed", "conflicting-bytes", "qualified artifact"],
  ["prior-deferred", "missing-tarball", "HTTP 404"],
  ["prior-deferred", "conflicting-bytes", "registry integrity"],
  ["prior-deferred", "archive-identity", "archive package identity"],
])(
  "rejects %s / %s before final success",
  async (mode, fault, message, distTagVersion = version, requestedVersion = version) => {
    const parent = await fixture(mode, fault, distTagVersion);
    await expect(parent.verify(packageName, requestedVersion, "beta")).rejects.toThrow(message);
    expect(parent.evidence).toEqual([]);
  },
);

it("verifies superseded registry bytes without inventing qualification receipts", async () => {
  const supersededBy = "2026.9.2-beta.2";
  const parent = await fixture("direct", "no-publish", supersededBy);
  await expect(parent.verify(packageName, version, "beta")).resolves.toBe(
    `${packageName}@${version} superseded by ${supersededBy}; dist-tag beta stays.`,
  );
  expect(parent.evidence).toMatchObject([
    {
      packageName,
      verification: "published-registry",
      supersededBy,
    },
  ]);
  expect(parent.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
});
