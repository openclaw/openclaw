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
    mode === "empty-selection" ? "direct" : mode,
    fault,
    distTagVersion,
  );
  const parent = await createPluginNpmPublicationReadback({
    ...value.options,
    ...(mode === "empty-selection" ? { plugins: [] } : {}),
  });
  return { ...value, ...parent };
}

it.each([
  ["missing-planned-job", "planned candidate"],
  ["empty-jobs", "successful planning job"],
])("rejects incomplete publication inventory: %s", async (fault, message) => {
  await expect(fixture("direct", fault)).rejects.toThrow(message);
});

it("verifies already-published registry bytes alongside qualified publishers in a mixed roster", async () => {
  const parent = await fixture("direct", "existing-package");
  await expect(parent.verify("@openclaw/existing", version, "beta")).resolves.toBeUndefined();
  await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
});

it.each([
  "direct",
  "prepared",
  "retained-qualification",
  "retained-publisher",
  "retained-plan",
  "replanned-failed",
  "empty-selection",
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
  ["direct", "missing-tarball", "HTTP 404"],
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

it.each([version, "2026.9.2-beta.2"])(
  "verifies already-published bytes with selector %s without inventing qualification receipts",
  async (distTagVersion) => {
    const parent = await fixture("direct", "no-publish", distTagVersion);
    const supersededBy = distTagVersion === version ? null : distTagVersion;
    await expect(parent.verify(packageName, version, "beta")).resolves.toBe(
      supersededBy
        ? `${packageName}@${version} superseded by ${supersededBy}; dist-tag beta stays.`
        : undefined,
    );
    expect(parent.evidence).toMatchObject([
      {
        packageName,
        verification: "published-registry",
        supersededBy,
      },
    ]);
    expect(parent.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
  },
);
