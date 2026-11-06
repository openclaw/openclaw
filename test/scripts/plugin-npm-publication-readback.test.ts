import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginNpmPublicationReadback,
  retryPluginNpmRead,
} from "../../scripts/plugin-npm-publication-readback.mjs";
import { parseGithubResponse } from "../../scripts/pr-lib/gh-api-preflight.mjs";
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
  it.each([
    ["missing-planned-job", "planned candidate"],
    ["empty-jobs", "successful planning job"],
  ])("rejects incomplete publication inventory: %s", async (fault, message) => {
    const value = await fixture("direct", fault);
    await expect(createPluginNpmPublicationReadback(value.options)).rejects.toThrow(message);
  });

  it("verifies already-published registry bytes alongside qualified publishers in a mixed roster", async () => {
    const value = await fixture("direct", "existing-package");
    const parent = await createPluginNpmPublicationReadback(value.options);
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
    const value = await fixture(mode === "empty-selection" ? "direct" : mode);
    const parent = await createPluginNpmPublicationReadback({
      ...value.options,
      ...(mode === "empty-selection" ? { plugins: [] } : {}),
    });
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
      const value = await fixture(mode, fault, distTagVersion);
      const parent = await createPluginNpmPublicationReadback(value.options);
      await expect(parent.verify(packageName, requestedVersion, "beta")).rejects.toThrow(message);
      expect(parent.evidence).toEqual([]);
    },
  );

  it.each([version, "2026.9.2-beta.2"])(
    "verifies already-published bytes with selector %s without inventing qualification receipts",
    async (distTagVersion) => {
      const value = await fixture("direct", "no-publish", distTagVersion);
      const parent = await createPluginNpmPublicationReadback(value.options);
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
      expect(value.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
    },
  );
});

afterEach(() => vi.useRealTimers());
const transientGitHubError = (stdout?: string) =>
  Object.assign(new Error("gh: HTTP 503"), { stderr: "HTTP 503 Server Error", stdout });
it("retries only transient GitHub reads and honors rate-limit guidance", async () => {
  const waits: number[] = [];
  const read = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(
      Object.assign(new Error("gh: HTTP 429"), {
        stdout: "HTTP/2 429 Too Many Requests\nretry-after: 7\n\n",
      }),
    )
    .mockResolvedValue("verified");
  await expect(
    retryPluginNpmRead(read, {
      attempts: 2,
      deadlineMs: 20_000,
      now: () => 0,
      delay: async (delayMs: number) => void waits.push(delayMs),
    }),
  ).resolves.toBe("verified");
  expect(waits).toEqual([7000]);

  const permanent = vi.fn(async () => {
    throw new Error("plugin artifact integrity or provenance differs");
  });
  await expect(
    retryPluginNpmRead(permanent, {
      delay: async () => {
        throw new Error("unexpected retry");
      },
    }),
  ).rejects.toThrow("integrity or provenance differs");
  expect(permanent).toHaveBeenCalledOnce();
});

it("revalidates child identity after a transient GET retry", async () => {
  const value = await createNpmPublicationReadbackFixture(
    tempDirs.make("npm-parent-readback-run-retry-"),
  );
  const runGh = value.options.runGh;
  let reads = 0;
  value.options.runGh = (args: string[]) => {
    if (args[1]?.endsWith(`/actions/runs/${value.options.runId}`)) {
      expect(args).toContain("--include");
      reads += 1;
      if (reads === 1) {
        throw transientGitHubError("HTTP/2 429 Too Many Requests\r\nretry-after: 7\r\n\r\n");
      }
      const run = parseGithubResponse(runGh(args)).body;
      run.head_sha = "c".repeat(40);
      return `HTTP/2 200 OK\r\n\r\n${JSON.stringify(run)}`;
    }
    return runGh(args);
  };
  vi.useFakeTimers();
  const pending = expect(createPluginNpmPublicationReadback(value.options)).rejects.toThrow(
    "child identity or successful attempt does not match publication",
  );
  await vi.advanceTimersByTimeAsync(6999);
  expect(reads).toBe(1);
  await vi.advanceTimersByTimeAsync(1);

  await pending;
  expect(reads).toBe(2);
});

it("revalidates publisher job identity after a transient inventory retry", async () => {
  const value = await createNpmPublicationReadbackFixture(
    tempDirs.make("npm-parent-readback-job-retry-"),
  );
  const runGh = value.options.runGh;
  let reads = 0;
  value.options.runGh = (args: string[]) => {
    if (args[1]?.includes(`/actions/runs/${value.options.runId}/jobs?`)) {
      expect(args).toContain("--include");
      reads += 1;
      if (reads === 1) {
        throw transientGitHubError();
      }
      const inventory = parseGithubResponse(runGh(args)).body;
      inventory.jobs.find((job: { name?: string }) =>
        job.name?.startsWith("Publish plugin npm package"),
      ).head_sha = "c".repeat(40);
      return `HTTP/2 200 OK\r\n\r\n${JSON.stringify(inventory)}`;
    }
    return runGh(args);
  };
  vi.useFakeTimers();
  const pending = expect(createPluginNpmPublicationReadback(value.options)).rejects.toThrow(
    "publisher job does not match",
  );
  await vi.advanceTimersByTimeAsync(1000);

  await pending;
  expect(reads).toBe(2);
});

it("revalidates artifact identity after a transient metadata retry", async () => {
  const value = await createNpmPublicationReadbackFixture(
    tempDirs.make("npm-parent-readback-artifact-retry-"),
  );
  const runGh = value.options.runGh;
  let reads = 0;
  value.options.runGh = (args: string[]) => {
    if (args[1]?.endsWith("/actions/artifacts/41")) {
      reads += 1;
      if (reads === 1) {
        throw transientGitHubError();
      }
      const artifact = parseGithubResponse(runGh(args)).body;
      artifact.digest = `sha256:${"f".repeat(64)}`;
      return `HTTP/2 200 OK\r\n\r\n${JSON.stringify(artifact)}`;
    }
    return runGh(args);
  };
  const parent = await createPluginNpmPublicationReadback(value.options);
  vi.useFakeTimers();
  const pending = expect(parent.verify(packageName, version, "beta")).rejects.toThrow(
    "immutable publication tuple",
  );
  await vi.advanceTimersByTimeAsync(1000);

  await pending;
  expect(reads).toBe(2);
});
