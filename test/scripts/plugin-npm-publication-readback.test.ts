import { afterEach, describe, expect, it } from "vitest";
import { createPluginNpmPublicationReadback } from "../../scripts/plugin-npm-publication-readback.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createNpmPublicationReadbackFixture,
  packageName,
  version,
} from "./plugin-npm-publication-readback.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = (mode = "direct", fault = "none", distTagVersion?: string) =>
  createNpmPublicationReadbackFixture(
    tempDirs.make("npm-parent-readback-"),
    mode,
    fault,
    distTagVersion,
  );

describe("parent plugin npm publication readback", () => {
  it("recovers a historical failed publisher only through its successful receipt step and exact bytes", async () => {
    const value = await fixture("replanned-failed");
    await expect(
      createPluginNpmPublicationReadback(value.options).then((parent) =>
        parent.verify(packageName, version, "beta"),
      ),
    ).resolves.toBeUndefined();
  });
  it.each(["missing-upload-step", "failed-upload-step", "conflicting-bytes"])(
    "keeps replanned failed publishers fail-closed for %s",
    async (fault) => {
      const value = await fixture("replanned-failed", fault);
      await expect(
        createPluginNpmPublicationReadback(value.options).then((parent) =>
          parent.verify(packageName, version, "beta"),
        ),
      ).rejects.toThrow(fault === "conflicting-bytes" ? "qualified artifact" : "producer step");
    },
  );
  it.each(["missing-tarball", "conflicting-bytes", "archive-identity"])(
    "does not let a fresh child skip readback after an earlier deferred publication: %s",
    async (fault) => {
      const prior = await fixture("direct", fault);
      const firstParent = await createPluginNpmPublicationReadback(prior.options);
      await expect(firstParent.verify(packageName, version, "beta")).rejects.toThrow(
        fault === "missing-tarball" ? "HTTP 404" : "qualified artifact",
      );
      const value = await fixture("prior-deferred", fault);
      const parent = await createPluginNpmPublicationReadback(value.options);
      await expect(parent.verify(packageName, version, "beta")).rejects.toThrow(
        fault === "missing-tarball"
          ? "HTTP 404"
          : fault === "archive-identity"
            ? "archive package identity"
            : "registry integrity",
      );
    },
  );
  it("rejects a mixed roster when a planned candidate has no publisher job", async () => {
    const value = await fixture("direct", "missing-planned-job");
    await expect(createPluginNpmPublicationReadback(value.options)).rejects.toThrow(
      "planned candidate",
    );
  });
  it("verifies already-published registry bytes alongside qualified publishers in a mixed roster", async () => {
    const value = await fixture("direct", "existing-package");
    const parent = await createPluginNpmPublicationReadback(value.options);
    await expect(parent.verify("@openclaw/existing", version, "beta")).resolves.toBeUndefined();
    await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
  });
  it("does not replace the parent release-version check with a different qualified version", async () => {
    const value = await fixture();
    const parent = await createPluginNpmPublicationReadback(value.options);
    await expect(parent.verify(packageName, "2026.9.2-beta.2", "beta")).rejects.toThrow(
      "release version",
    );
  });
  it("retains the default all-publishable roster for an empty CLI selection", async () => {
    const value = await fixture();
    const parent = await createPluginNpmPublicationReadback({ ...value.options, plugins: [] });
    await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
  });
  it.each(["direct", "prepared", "retained-qualification", "retained-publisher", "retained-plan"])(
    "verifies exact qualified bytes through the %s producer binding",
    async (mode) => {
      const value = await fixture(mode);
      const parent = await createPluginNpmPublicationReadback(value.options);
      await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
      expect(value.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
      expect(parent.evidence).toMatchObject([
        {
          producerRunId: value.producerId,
          producerRunAttempt: value.producerAttempt,
          publisherAttempt: value.publisherAttempt,
          artifactId: 41,
        },
      ]);
    },
  );

  it.each([
    ["missing-receipt", "Expected one consumed"],
    ["missing-tarball", "HTTP 404"],
    ["conflicting-bytes", "bytes differ"],
    ["source", "approved package or source"],
    ["attempt", "producer-attempt binding"],
    ["artifact", "immutable publication tuple"],
  ])("rejects %s before final success", async (fault, message) => {
    const value = await fixture("direct", fault);
    const parent = await createPluginNpmPublicationReadback(value.options);
    await expect(parent.verify(packageName, version, "beta")).rejects.toThrow(message);
    expect(parent.evidence).toEqual([]);
  });

  it("verifies existing registry bytes without inventing qualification receipts", async () => {
    const value = await fixture("direct", "no-publish");
    const parent = await createPluginNpmPublicationReadback(value.options);
    await expect(parent.verify(packageName, version, "beta")).resolves.toBeUndefined();
    expect(parent.evidence).toMatchObject([{ packageName, verification: "published-registry" }]);
    expect(value.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
  });

  it("passes a skipped version a later release superseded with a note and no tag check", async () => {
    const value = await fixture("direct", "no-publish", "2026.9.2-beta.2");
    const parent = await createPluginNpmPublicationReadback(value.options);
    await expect(parent.verify(packageName, version, "beta")).resolves.toBe(
      `${packageName}@${version} superseded by 2026.9.2-beta.2; dist-tag beta stays.`,
    );
    expect(parent.evidence).toMatchObject([
      { packageName, verification: "published-registry", supersededBy: "2026.9.2-beta.2" },
    ]);
    expect(value.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
  });

  it.each([
    ["lagging selector on a skipped version", "no-publish", "2026.9.1-beta.1"],
    ["ahead selector on a version this run published", "none", "2026.9.2-beta.2"],
  ])("still rejects a %s", async (_label, fault, distTagVersion) => {
    const value = await fixture("direct", fault, distTagVersion);
    const parent = await createPluginNpmPublicationReadback(value.options);
    await expect(parent.verify(packageName, version, "beta")).rejects.toThrow(
      "differs from the prepared version",
    );
    expect(parent.evidence).toEqual([]);
  });

  it("does not interpret a missing job inventory as no new publication", async () => {
    const value = await fixture("direct", "empty-jobs");
    await expect(createPluginNpmPublicationReadback(value.options)).rejects.toThrow(
      "successful planning job",
    );
  });
});
