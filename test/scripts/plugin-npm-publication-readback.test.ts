import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.useRealTimers());

const transientGitHubError = (stdout?: string) =>
  Object.assign(new Error("gh: HTTP 503"), { stderr: "HTTP 503 Server Error", stdout });

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

it.each([
  [
    "revalidates child identity after a transient GET retry",
    "run",
    "child identity or successful attempt does not match publication",
  ],
  [
    "revalidates publisher job identity after a transient inventory retry",
    "jobs",
    "publisher job does not match",
  ],
  [
    "revalidates artifact identity after a transient metadata retry",
    "artifact",
    "immutable publication tuple",
  ],
] as const)("%s", async (_name, stage, message) => {
  const value = await createNpmPublicationReadbackFixture(
    tempDirs.make(`npm-parent-readback-${stage}-retry-`),
  );
  const runGh = value.options.runGh;
  let reads = 0;
  value.options.runGh = (args: string[]) => {
    const endpoint = args[1] ?? "";
    const matches =
      stage === "run"
        ? endpoint.endsWith(`/actions/runs/${value.options.runId}`)
        : stage === "jobs"
          ? endpoint.includes(`/actions/runs/${value.options.runId}/jobs?`)
          : endpoint.endsWith("/actions/artifacts/41");
    if (!matches) {
      return runGh(args);
    }
    if (stage !== "artifact") {
      expect(args).toContain("--include");
    }
    reads += 1;
    if (reads === 1) {
      throw transientGitHubError(
        stage === "run" ? "HTTP/2 429 Too Many Requests\r\nretry-after: 7\r\n\r\n" : undefined,
      );
    }
    const body = parseGithubResponse(runGh(args)).body;
    if (stage === "run") {
      body.head_sha = "c".repeat(40);
    } else if (stage === "jobs") {
      body.jobs.find((job: { name?: string }) =>
        job.name?.startsWith("Publish plugin npm package"),
      ).head_sha = "c".repeat(40);
    } else {
      body.digest = `sha256:${"f".repeat(64)}`;
    }
    return `HTTP/2 200 OK\r\n\r\n${JSON.stringify(body)}`;
  };
  const parent =
    stage === "artifact" ? await createPluginNpmPublicationReadback(value.options) : undefined;
  vi.useFakeTimers();
  const pending = expect(
    parent
      ? parent.verify(packageName, version, "beta")
      : createPluginNpmPublicationReadback(value.options),
  ).rejects.toThrow(message);
  if (stage === "run") {
    await vi.advanceTimersByTimeAsync(6999);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
  } else {
    await vi.advanceTimersByTimeAsync(1000);
  }
  await pending;
  expect(reads).toBe(2);
});

it("verifies already-published registry bytes alongside qualified publishers in a mixed roster", async () => {
  const parent = await fixture("direct", "existing-package");
  await expect(parent.verify("@openclaw/existing", version, "beta")).resolves.toEqual({
    disposition: "published",
  });
  await expect(parent.verify(packageName, version, "beta")).resolves.toEqual({
    disposition: "published",
  });
});

it.each([
  "prepared",
  "candidate-prepared",
  "retained-qualification",
  "retained-publisher",
  "retained-plan",
  "replanned-failed",
])("verifies exact qualified bytes through the %s producer binding", async (mode) => {
  const parent = await fixture(mode);
  await expect(parent.verify(packageName, version, "beta")).resolves.toEqual({
    disposition: "published",
  });
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
  ["candidate-prepared", "workflow", "approved package or source"],
  ["candidate-prepared", "producer-sha", "immutable publication tuple"],
  ["candidate-prepared", "policy", "canonically bind"],
  ["candidate-prepared", "source-policy", "canonically bind"],
  ["direct", "same-run-q", "approved package or source"],
  ["candidate-prepared", "conflicting-bytes", "bytes differ"],
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
  await expect(parent.verify(packageName, version, "beta")).resolves.toEqual({
    disposition: "published",
    note: `${packageName}@${version} superseded by ${supersededBy}; dist-tag beta stays.`,
  });
  expect(parent.evidence).toMatchObject([
    {
      packageName,
      verification: "published-registry",
      supersededBy,
    },
  ]);
  expect(parent.requests.filter((url) => url.endsWith(".tgz"))).toHaveLength(1);
});

it("retains explicit authentication deferrals without fabricating a published disposition", async () => {
  const result = await fixture("operator-deferred");
  await expect(result.verify(packageName, version, "beta")).resolves.toMatchObject({
    disposition: "deferred-auth",
    note: expect.stringContaining("npm-trusted-publisher-exchange-http-404"),
  });
  expect(result.evidence).toContainEqual(
    expect.objectContaining({
      verification: "operator-deferred-auth",
      packageName,
      version,
      evidence: "https://github.com/openclaw/openclaw/actions/runs/12/job/34",
    }),
  );
  expect(result.requests.some((url) => url.startsWith("https://registry.npmjs.org/"))).toBe(true);
  await expect(fixture("operator-deferred", "deferred-invalid")).rejects.toThrow("exact-source");
  const published = await fixture("operator-deferred", "deferred-published");
  await expect(published.verify(packageName, version, "beta")).resolves.toMatchObject({
    disposition: "published",
  });
  const unavailable = await fixture("operator-deferred", "deferred-registry-error");
  await expect(unavailable.verify(packageName, version, "beta")).rejects.toThrow();
});
