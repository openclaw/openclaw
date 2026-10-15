import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createClawHubRecoveryManifest,
  executeClawHubRecoveryManifest,
} from "../../scripts/plugin-clawhub-recovery.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.7";
const pending = {
  name: "@openclaw/example",
  version,
  publicationStatus: "pending",
  attemptId: "attempt-1",
};

function render(
  records: unknown[],
  reason = "Parent failed after staging",
  releaseVersion = version,
  separator: string[] = [],
  publicationState?: unknown,
) {
  const directory = directories.make("clawhub-recovery-");
  const paths = records.map((record, index) => {
    const path = join(directory, `${index}.json`);
    writeFileSync(path, JSON.stringify(record));
    return path;
  });
  const transport = join(directory, "transport.mjs");
  writeFileSync(
    transport,
    `globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") throw new Error("Unexpected mutation");
    const name = decodeURIComponent(new URL(url).pathname.split("/")[4]);
    if (name === "@openclaw/done") return Response.json({ name, version: ${JSON.stringify(releaseVersion)}, state: "published" });
    return Response.json({ name, version: ${JSON.stringify(releaseVersion)},
      ...${JSON.stringify(publicationState ?? { state: "failed", recoverable: true })},
      ...(${JSON.stringify(publicationState === undefined)} ? { attemptId: name === "@openclaw/failed" ? "attempt-2" : "attempt-1" } : {}) });
  };`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      transport,
      "scripts/plugin-clawhub-recovery.mjs",
      ...separator,
      "--version",
      releaseVersion,
      "--reason",
      reason,
      "--clawhub-source",
      join(directory, "source checkout"),
      ...paths,
    ],
    { encoding: "utf8" },
  );
  return { directory, ...result };
}

describe("ClawHub staged publication recovery commands", () => {
  it("rejects a version that could escape the generated comment", () => {
    const releaseVersion = "2026.9.7\necho injected";
    const result = render([{ ...pending, version: releaseVersion }], "Recovery", releaseVersion);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("preserves exact attempts and safely quotes commands while skipping published packages", () => {
    const reason = "Parent's failure; $(printf INJECTED)";
    const result = render(
      [
        pending,
        {
          ...pending,
          name: "@openclaw/done",
          publicationStatus: "published",
          attemptId: undefined,
        },
        {
          ...pending,
          name: "@openclaw/failed",
          publicationStatus: "failed",
          attemptId: "attempt-2",
        },
      ],
      reason,
      version,
      ["--"],
    );
    expect(result.status, result.stderr).toBe(0);
    const bun = join(result.directory, "bun");
    writeFileSync(
      bun,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(bun, 0o755);
    const invoked = spawnSync("/bin/sh", ["-c", result.stdout], {
      cwd: result.directory,
      env: { ...process.env, PATH: `${result.directory}:${process.env.PATH}` },
      encoding: "utf8",
    });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(
      invoked.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      ["attempt-1", "attempt-2"].map((attempt) => [
        join(result.directory, "source checkout/packages/clawhub/src/cli.ts"),
        "--registry",
        "https://clawhub.ai",
        "--no-input",
        "package",
        "recover",
        attempt,
        "--manual-override-reason",
        reason,
        "--wait",
        "--wait-timeout",
        "1800",
        "--json",
      ]),
    );
  });

  it.each([
    { state: "pending", stage: "finalization", attemptId: pending.attemptId },
    { state: "pending", stage: "finalization", attemptId: "successor-attempt" },
    { state: "published" },
  ])("does not generate recovery mutation for authoritative $state", (publication) => {
    const result = render([pending], "Recovery", version, [], publication);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("package recover");
    expect(result.stdout).toContain(publication.state === "pending" ? "finalizer" : "verified");
    if (publication.state === "pending") {
      expect(result.stdout).toContain(
        `targeted prepublication worker for attempt ${publication.attemptId}.`,
      );
    }
  });

  it("refuses a terminal public failure before emitting a recovery command", () => {
    const result = render([pending], "Recovery", version, [], {
      state: "failed",
      recoverable: false,
      attemptId: pending.attemptId,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each([
    { ...pending, name: "@openclaw/other", version: "2026.9.8" },
    { ...pending, name: "@openclaw/other", attemptId: undefined },
    { ...pending, name: "@openclaw/other", publicationStatus: "blocked" },
    pending,
  ])("rejects incomplete or mixed evidence before emitting any recovery command", (invalid) => {
    const result = render([pending, invalid]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

const transactions = {
  schemaVersion: 1,
  identity: {
    version: 2,
    repository: "openclaw/openclaw",
    workflow: ".github/workflows/plugin-clawhub-release.yml",
    runId: "20",
    runAttempt: "1",
    ref: "release-publish/aaaaaaaaaaaa-10",
    fullRef: "refs/tags/release-publish/aaaaaaaaaaaa-10",
    sha: "a".repeat(40),
    candidateRepository: "openclaw/openclaw",
    candidateSha: "b".repeat(40),
    toolingRef: "release-publish/aaaaaaaaaaaa-10",
    toolingFullRef: "refs/tags/release-publish/aaaaaaaaaaaa-10",
    toolingSha: "a".repeat(40),
    parentRepository: "openclaw/openclaw",
    parentWorkflow: ".github/workflows/openclaw-release-publish.yml",
    parentRunId: "10",
    parentRunAttempt: "1",
  },
  packages: [
    {
      name: pending.name,
      version,
      artifactName: "clawhub-package-example",
      artifactSha256: "c".repeat(64),
      artifactSize: 123,
      inventoryDigest: "e".repeat(64),
    },
  ],
};

describe("sealed ClawHub recovery manifest", () => {
  it("seals every available attempt when the complete manifest is unavailable", () => {
    const directory = directories.make("clawhub-cleanup-snapshot-");
    const recordPath = join(directory, "package-publish.json");
    const outputPath = join(directory, "cleanup-snapshot.json");
    writeFileSync(recordPath, JSON.stringify(pending));
    const result = spawnSync(
      process.execPath,
      ["scripts/plugin-clawhub-recovery.mjs", "snapshot", "--output", outputPath, recordPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHILD_RUN_ID: "20",
          CHILD_RUN_ATTEMPT: "1",
          COMPLETE_MANIFEST_AVAILABLE: "false",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({
      childRunId: "20",
      completeManifestAvailable: false,
      packages: [{ name: pending.name, attemptId: pending.attemptId }],
    });
  });

  it("seals unavailable packages without inventing an attempt ID", () => {
    expect(createClawHubRecoveryManifest(transactions, []).packages).toEqual([
      expect.objectContaining({
        name: pending.name,
        publicationStatus: "unavailable",
      }),
    ]);
    expect(createClawHubRecoveryManifest(transactions, []).packages[0]).not.toHaveProperty(
      "attemptId",
    );
  });

  it("refuses an unavailable package before recovering any staged attempt", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      executeClawHubRecoveryManifest({
        manifest: createClawHubRecoveryManifest(transactions, []),
        reason: "Parent failed after sealed staging",
        token: "fixture-token",
        fetchImpl,
      }),
    ).rejects.toThrow("was not staged and has no recoverable attempt");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["pending", "published"])(
    "verifies a recorded %s receipt against public state",
    async (recorded) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          name: pending.name,
          version,
          state: "failed",
          recoverable: false,
          attemptId: pending.attemptId,
        }),
      );
      await expect(
        executeClawHubRecoveryManifest({
          manifest: createClawHubRecoveryManifest(transactions, [
            { ...pending, publicationStatus: recorded },
          ]),
          reason: "Recovery",
          token: "fixture-token",
          fetchImpl,
        }),
      ).rejects.toThrow("not recoverable");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("explains recovery before sending its mutation", async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") {
        expect(messages.at(-1)).toContain(`recover sealed attempt ${pending.attemptId}`);
        return Response.json({
          name: pending.name,
          version,
          recoveredFromAttemptId: pending.attemptId,
          attemptId: "attempt-2",
          publicationStatus: "published",
        });
      }
      return Response.json({
        name: pending.name,
        version,
        state: "failed",
        recoverable: true,
        attemptId: pending.attemptId,
      });
    });
    await executeClawHubRecoveryManifest({
      manifest: createClawHubRecoveryManifest(transactions, [pending]),
      reason: "Recovery",
      token: "fixture-token",
      fetchImpl,
      report: (message: string) => messages.push(message),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("hands pending finalization to the existing worker without creating a successor", async () => {
    const messages: string[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          name: pending.name,
          version,
          state: "pending",
          stage: "finalization",
          attemptId: pending.attemptId,
        }),
      )
      .mockResolvedValueOnce(Response.json({ name: pending.name, version, state: "published" }));
    const result = await executeClawHubRecoveryManifest({
      manifest: createClawHubRecoveryManifest(transactions, [pending]),
      reason: "Recovery",
      token: "fixture-token",
      fetchImpl,
      wait: async () => {},
      report: (message: string) => messages.push(message),
    });
    expect(result).toEqual({ schemaVersion: 1, complete: true, recovered: [] });
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(messages.join("\n")).toContain("finalizer");
    expect(messages.join("\n")).toContain("verified");
    expect(messages.filter((message) => message.includes("finalizer"))).toHaveLength(1);
  });

  it("recovers with current publisher authority without private original attempt access", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    let publicationRequest = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/publication")) {
        publicationRequest += 1;
        if (publicationRequest === 2) {
          return Response.json({
            name: pending.name,
            version,
            state: "failed",
            recoverable: true,
          });
        }
        return Response.json({
          name: pending.name,
          version,
          ...(publicationRequest < 4
            ? { state: "failed", attemptId: "attempt-1", recoverable: true }
            : { state: "published" }),
        });
      }
      if (init?.method === "POST") {
        return Response.json({
          recoveredFromAttemptId: "attempt-1",
          attemptId: "attempt-2",
          name: pending.name,
          version,
          publicationStatus: "pending",
        });
      }
      if (url.endsWith("/attempt-2")) {
        return Response.json({
          attemptId: "attempt-2",
          name: pending.name,
          version,
          publicationStatus: "pending",
        });
      }
      return new Response("Not found", { status: 404 });
    };
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: "Parent failed after sealed staging",
      token: "fixture-token",
      registry: "https://clawhub.example",
      fetchImpl,
      wait: async () => {},
    });
    expect(result).toMatchObject({ complete: true, recovered: [{ attemptId: "attempt-2" }] });
    expect(requests).toEqual([
      {
        url: `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}/publication`,
        method: "GET",
        body: undefined,
      },
      {
        url: "https://clawhub.example/api/v1/publish/attempts/attempt-1/recover",
        method: "POST",
        body: JSON.stringify({ manualOverrideReason: "Parent failed after sealed staging" }),
      },
      {
        url: `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}/publication`,
        method: "GET",
        body: undefined,
      },
      {
        url: "https://clawhub.example/api/v1/publish/attempts/attempt-2",
        method: "GET",
        body: undefined,
      },
      {
        url: `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}/publication`,
        method: "GET",
        body: undefined,
      },
      {
        url: "https://clawhub.example/api/v1/publish/attempts/attempt-2",
        method: "GET",
        body: undefined,
      },
      {
        url: `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}/publication`,
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("leaves an unrelated replacement attempt to authoritative recovery validation", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          name: pending.name,
          version,
          state: "failed",
          attemptId: "attempt-2",
          recoverable: true,
        }),
      )
      .mockResolvedValueOnce(new Response("Recovery replay binding changed", { status: 409 }));
    await expect(
      executeClawHubRecoveryManifest({
        manifest,
        reason: "Parent failed after sealed staging",
        token: "fixture-token",
        fetchImpl,
      }),
    ).rejects.toThrow("HTTP 409");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://clawhub.ai/api/v1/publish/attempts/attempt-1/recover",
    );
  });

  it("reattaches to an idempotent recovery after an interrupted executor", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          name: pending.name,
          version,
          state: "pending",
          stage: "checks",
          attemptId: "attempt-2",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          recoveredFromAttemptId: pending.attemptId,
          attemptId: "attempt-2",
          name: pending.name,
          version,
          publicationStatus: "pending",
          reused: true,
        }),
      )
      .mockResolvedValueOnce(Response.json({ name: pending.name, version, state: "published" }));
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: "Parent failed after sealed staging",
      token: "fixture-token",
      fetchImpl,
      wait: async () => {},
    });
    expect(result).toMatchObject({ complete: true, recovered: [{ attemptId: "attempt-2" }] });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it.each([
    { name: "anonymous failure", publication: { recoverable: false } },
    {
      name: "stale original attempt",
      publication: { attemptId: pending.attemptId, recoverable: true },
    },
  ])("reports the current recovery failure behind $name", async ({ publication }) => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const attempt = {
      attemptId: "attempt-2",
      name: pending.name,
      version,
      publicationStatus: "pending",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          name: pending.name,
          version,
          state: "failed",
          attemptId: pending.attemptId,
          recoverable: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ ...attempt, recoveredFromAttemptId: pending.attemptId }),
      )
      .mockResolvedValueOnce(
        Response.json({ name: pending.name, version, state: "failed", ...publication }),
      )
      .mockResolvedValueOnce(Response.json({ ...attempt, publicationStatus: "failed" }));
    await expect(
      executeClawHubRecoveryManifest({
        manifest,
        reason: "Parent failed after sealed staging",
        token: "fixture-token",
        fetchImpl,
      }),
    ).rejects.toThrow(`ClawHub recovery failed: ${pending.name}.`);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      name: "current publication state",
      publication: "published",
      exact: undefined,
      recovers: false,
    },
    {
      name: "legacy publication-route 404",
      publication: "not-found",
      exact: "published",
      recovers: false,
    },
    {
      name: "legacy version JSON on the publication route",
      publication: "version",
      exact: "not-found",
      recovers: true,
    },
  ])("resolves $name before recovery", async (testCase) => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const requests: Array<{ url: string; method: string }> = [];
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: "Parent failed after sealed staging",
      token: "fixture-token",
      registry: "https://clawhub.example",
      fetchImpl: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (method === "POST") {
          return Response.json({
            recoveredFromAttemptId: pending.attemptId,
            attemptId: "attempt-2",
            name: pending.name,
            version,
            publicationStatus: "published",
          });
        }
        if (url.endsWith("/publication")) {
          if (testCase.publication === "not-found") {
            return new Response("Not found", { status: 404 });
          }
          return Response.json(
            testCase.publication === "published"
              ? { name: pending.name, version, state: "published" }
              : { version },
          );
        }
        expect(url).toBe(
          `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}`,
        );
        return testCase.exact === "published"
          ? Response.json({ version })
          : new Response("Not found", { status: 404 });
      },
      wait: async () => {},
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      complete: true,
      recovered: testCase.recovers ? [{ attemptId: "attempt-2" }] : [],
    });
    expect(requests).toEqual([
      {
        url: `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}/publication`,
        method: "GET",
      },
      ...(testCase.exact
        ? [
            {
              url: `https://clawhub.example/api/v1/packages/${encodeURIComponent(pending.name)}/versions/${version}`,
              method: "GET",
            },
          ]
        : []),
      ...(testCase.recovers
        ? [
            {
              url: "https://clawhub.example/api/v1/publish/attempts/attempt-1/recover",
              method: "POST",
            },
          ]
        : []),
    ]);
  });

  it("waits through a legacy pending recovery conflict", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const responses = [
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      new Response("Attempt is still pending", {
        status: 409,
        headers: { "Retry-After": "10" },
      }),
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      Response.json({ version }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    const wait = vi.fn(async () => {});
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: "Parent failed after sealed staging",
      token: "fixture-token",
      fetchImpl,
      wait,
    });
    expect(result).toEqual({ schemaVersion: 1, complete: true, recovered: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(wait).toHaveBeenCalledWith(10_000);
  });

  it("does not retry a permanent legacy recovery conflict", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Recovery replay binding changed", { status: 409 }))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    await expect(
      executeClawHubRecoveryManifest({
        manifest,
        reason: "Parent failed after sealed staging",
        token: "fixture-token",
        fetchImpl,
      }),
    ).rejects.toThrow("HTTP 409");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("accepts publication that wins a legacy recovery conflict race", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const responses = [
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      new Response("Attempt is no longer recoverable", { status: 409 }),
      new Response("Not found", { status: 404 }),
      Response.json({ version }),
    ];
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: "Parent failed after sealed staging",
      token: "fixture-token",
      fetchImpl: vi.fn<typeof fetch>(async () => responses.shift()!),
    });
    expect(result).toEqual({ schemaVersion: 1, complete: true, recovered: [] });
    expect(responses).toEqual([]);
  });

  it("does not honor Retry-After beyond the recovery deadline", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const responses = [
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      new Response("Attempt is still pending", {
        status: 409,
        headers: { "Retry-After": "10" },
      }),
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
    ];
    const wait = vi.fn(async () => {});
    await expect(
      executeClawHubRecoveryManifest({
        manifest,
        reason: "Parent failed after sealed staging",
        token: "fixture-token",
        fetchImpl: vi.fn<typeof fetch>(async () => responses.shift()!),
        timeoutMilliseconds: 5_000,
        wait,
      }),
    ).rejects.toThrow(`ClawHub recovery timed out: ${pending.name}.`);
    expect(wait).not.toHaveBeenCalled();
  });

  it("reports a failed recovery through a legacy publication fallback", async () => {
    const manifest = createClawHubRecoveryManifest(transactions, [pending]);
    const attempt = {
      attemptId: "attempt-2",
      name: pending.name,
      version,
    };
    const responses = [
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      Response.json({
        ...attempt,
        recoveredFromAttemptId: pending.attemptId,
        publicationStatus: "pending",
      }),
      new Response("Not found", { status: 404 }),
      new Response("Not found", { status: 404 }),
      Response.json({ ...attempt, publicationStatus: "failed" }),
    ];
    await expect(
      executeClawHubRecoveryManifest({
        manifest,
        reason: "Parent failed after sealed staging",
        token: "fixture-token",
        fetchImpl: vi.fn<typeof fetch>(async () => responses.shift()!),
      }),
    ).rejects.toThrow(`ClawHub recovery failed: ${pending.name}.`);
    expect(responses).toEqual([]);
  });

  it("keeps automated recovery behind approval and preserves the manifest before cancellation", () => {
    const recovery = parse(readFileSync(".github/workflows/plugin-clawhub-recovery.yml", "utf8"));
    expect(recovery.jobs.recover.environment).toBe("clawhub-plugin-release");
    const recoveryNames = recovery.jobs.recover.steps.map((step: { name?: string }) => step.name);
    expect(
      recoveryNames.indexOf("Validate original sealed authority and exact recovery roster"),
    ).toBeLessThan(recoveryNames.indexOf("Recover every non-public exact attempt"));
    expect(
      recovery.jobs.recover.steps.find(
        (step: { name?: string }) => step.name === "Recover every non-public exact attempt",
      ).run,
    ).toContain("plugin-clawhub-recovery.mjs execute");

    const release = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
    const cleanupNames = release.jobs.cleanup_clawhub.steps.map(
      (step: { name?: string }) => step.name,
    );
    expect(
      cleanupNames.indexOf("Download sealed recovery manifest before cancellation"),
    ).toBeLessThan(cleanupNames.indexOf("Cancel unfinished ClawHub children"));
    expect(cleanupNames.indexOf("Upload sealed cleanup evidence")).toBeLessThan(
      cleanupNames.indexOf("Cancel unfinished ClawHub children"),
    );
    expect(
      release.jobs.cleanup_clawhub.steps.find(
        (step: { name?: string }) =>
          step.name === "Download sealed recovery manifest before cancellation",
      )["continue-on-error"],
    ).toBe(true);
    expect(release.jobs).not.toHaveProperty("verify_clawhub_publication");

    const child = parse(readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8"));
    expect(child.jobs.seal_clawhub_recovery_manifest.steps.at(-1).with.name).toContain(
      "openclaw-clawhub-recovery-manifest-",
    );
    expect(
      child.jobs.seal_clawhub_recovery_manifest.steps.find(
        (step: { name?: string }) => step.name === "Download package publication receipts",
      )["continue-on-error"],
    ).toBe(true);
  });
});
