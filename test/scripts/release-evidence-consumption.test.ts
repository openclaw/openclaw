import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateReceiptRecovery,
  verifyOriginalReceiptQualification,
  revalidateReceiptRecoveryRuns,
} from "../../scripts/full-release-receipt-recovery.mjs";
import * as preflightTransport from "../../scripts/lib/release-publish-preflight-evidence.mts";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { runReleasePublishPreflight } from "../../scripts/release-publish-preflight.mts";
import {
  qualificationRequiredChildJobs,
  validateQualificationChildCompleteness,
} from "../../scripts/release-qualification-coverage.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { recoveryCandidateFixture, recoveryProfiles } from "./channel-recovery.test-support.js";
import {
  recoveryConsumptionFixture,
  consumptionOptions,
} from "./release-evidence-consumption.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("release evidence consumption", () => {
  it.each(recoveryProfiles)(
    "accepts authenticated %s recovery of frozen Q qualification for publication",
    async (profile) => {
      const f = recoveryConsumptionFixture(recoveryCandidateFixture(profile));
      const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
      for (const child of original.children) {
        validateQualificationChildCompleteness({
          role: child.role,
          inputs: child.receipt.inputs,
          jobs: child.receipt.jobs,
          getSource: (path) => readFileSync(path, "utf8"),
        });
      }
      f.manifest.retainedPublicationPayloads = original.publication.payloads;
      const recovered = await authenticateReceiptRecovery({
        manifest: f.manifest,
        artifact: f.aggregateArtifact,
        run: f.run,
        client: f.client,
        verifier: undefined,
        expectedRunAttempts: undefined,
      });
      expect(recovered.current.workflowRefProof).toBe("receipt-backed-recovery-v1");
      const options = {
        ...consumptionOptions(f.direct),
        run: f.run,
        manifest: f.manifest,
        expectedRunId: "900",
      };
      const strict = await validateReleaseRunEvidence(
        {
          repository: f.direct.repository,
          runId: "900",
          trustedWorkflowFullRef: f.direct.publisherFullRef,
          trustedWorkflowRef: f.direct.publisherFullRef.slice("refs/tags/".length),
          trustedWorkflowSha: f.direct.p,
          verifierSourceSha: f.direct.p,
          verifierSourceContent: options.verifierSourceContent,
        },
        f.client,
      );
      expect(strict.current.conclusion).toBe("success");
      const consumed = await authenticateFullReleaseValidationEvidence(options, f.client);
      expect(consumed.evidence.current.conclusion).toBe("success");
      // This is the already-authenticated handoff used by publication preflight.
      const publication = consumed.forPublication(options);
      const artifactFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith("https://registry.npmjs.org/")
          ? Promise.resolve(Response.json({ versions: {}, "dist-tags": {} }))
          : artifactFetch(input, init);
      });
      vi.spyOn(preflightTransport, "createPublishPreflightGh").mockReturnValue((args) => {
        const path = args[1] ?? "";
        if (path.includes("/git/ref/tags/")) {
          return JSON.stringify({
            ref: f.direct.publisherFullRef,
            object: { type: "commit", sha: f.direct.p },
          });
        }
        return f.runGh(args);
      });
      const manifestReads = vi.spyOn(f.client, "loadManifest");
      vi.spyOn(preflightTransport, "createPublishPreflightEvidenceClient").mockReturnValue(
        f.client,
      );
      const preflight = await runReleasePublishPreflight(
        {
          repo: f.direct.repository,
          tag: "v" + f.recovery.candidateBinding.package.version,
          fullReleaseValidationRunId: "900",
          fullReleaseValidationRunAttempt: 1,
          npmDistTag: f.source.publicationSelection!.npmDistTag,
          pluginPublishScope: "all-publishable",
          workflowRef: f.direct.publisherFullRef.slice("refs/tags/".length),
        },
        {
          manifest: f.manifest,
          targetSha: f.direct.q,
          toolingSha: f.direct.p,
          allowPlannedTag: true,
          fullValidationEvidence: consumed,
        },
      );
      // Only the changed provenance gate is under test. Synthetic Q has no local
      // checkout or registry publication, so unrelated release gates must not pass.
      expect(preflight.rows.find((row) => row.id === "validation.provenance")).toMatchObject({
        status: "PASS",
      });
      expect(preflight.failed).toBe(true);
      expect(manifestReads).not.toHaveBeenCalled();
      expect(publication.source).toBe("receipt-backed-recovery-v1");
      if (profile === "beta") {
        const direct = await authenticateFullReleaseValidationEvidence(
          consumptionOptions(f.direct),
          {
            ...f.client,
            ...f.direct.client,
          },
        );
        for (const [result, kind] of [
          [direct, "direct"],
          [consumed, "recovery"],
        ] as const) {
          expect(result.qualification).toMatchObject({
            kind,
            candidateSha: f.direct.q,
            qualificationSha: f.direct.q,
            admission: f.direct.admission.receipt,
            coverage: f.direct.admission.receipt.coverage,
            coveragePolicy: "npm-beta-v1",
          });
        }
      }
      expect(consumed.qualification.coverage).toEqual(f.direct.admission.receipt.coverage);
      expect(consumed.qualification.coveragePolicy ?? "").toBe(f.source.coverage.coverage_policy);
      expect(consumed.evidence.releaseProfile).toBe(
        profile === "extended-stable" ? "stable" : profile,
      );
      expect(consumed.evidence.runReleaseSoak).toBe(profile !== "beta");
    },
  );
});

describe("recovery qualification integrity at consumption", () => {
  it.each(["stable", "full"] as const)(
    "requires substantive %s soak jobs, not only the aggregate",
    (profile) => {
      const missing =
        "Run repo/live E2E validation / Docker live suites (Docker live gateway OpenAI)";
      const f = recoveryConsumptionFixture(recoveryCandidateFixture(profile), (child) => {
        if (child.role !== "releaseChecksIndependent") {
          return;
        }
        const index = child.jobs.findIndex((job) => job.name === missing);
        expect(index).toBeGreaterThanOrEqual(0);
        child.jobs.splice(index, 1);
      });
      const child = f.recovery.children.releaseChecksIndependent!;
      expect(
        f.jobs.get(child.runId)!.find((job) => job.name === "Verify release checks"),
      ).toMatchObject({ conclusion: "success" });
      expect(() =>
        validateQualificationChildCompleteness({
          role: "releaseChecksIndependent",
          inputs: child.inputs,
          jobs: f.jobs.get(child.runId),
          getSource: (path) => readFileSync(path, "utf8"),
        }),
      ).toThrow("required job did not succeed exactly once: " + missing);
    },
  );

  it("preserves advisory job failures outside the required leaf contract", () => {
    const f = recoveryConsumptionFixture(recoveryCandidateFixture("full"));
    const child = f.recovery.children.releaseChecksCandidate!;
    const jobs = [
      ...f.jobs.get(child.runId)!,
      {
        id: 90001,
        name: "Run Windows-node main E2E",
        status: "completed",
        conclusion: "failure",
      },
    ];
    expect(() =>
      validateQualificationChildCompleteness({
        role: "releaseChecksCandidate",
        inputs: child.inputs,
        jobs,
        getSource: (path) => readFileSync(path, "utf8"),
      }),
    ).not.toThrow();
  });

  it("uses frozen Q Node matrix versions and rejects an unsupported Q matrix shape", () => {
    const f = recoveryConsumptionFixture(recoveryCandidateFixture("full"));
    const context = {
      role: "releaseChecksCandidate",
      inputs: f.recovery.children.releaseChecksCandidate!.inputs,
      getSource: (path: string) => readFileSync(path, "utf8").replaceAll("26.12.1", "26.9.0"),
    };
    const required = qualificationRequiredChildJobs(context);
    expect(required).toContain("cross_os_release_checks / Windows / packaged fresh (Node 26.9.0)");
    expect(required.some((name) => name.includes("26.12.1"))).toBe(false);
    const frozenInventory = qualificationRequiredChildJobs({
      ...context,
      getSource: (path) => {
        const source = readFileSync(path, "utf8");
        if (path !== "scripts/lib/update-compat-inventory.json") {
          return source;
        }
        const inventory = JSON.parse(source);
        inventory.releases = [{ version: "2026.9.1" }];
        return JSON.stringify(inventory);
      },
    });
    expect(frozenInventory.some((name) => name.includes("update-first-hop-compat-2026.9.1)"))).toBe(
      true,
    );
    expect(frozenInventory.some((name) => name.includes("update-first-hop-compat-2026.9.2)"))).toBe(
      false,
    );
    expect(() =>
      qualificationRequiredChildJobs({
        ...context,
        getSource: (path) =>
          readFileSync(path, "utf8").replace(
            '[node24Version, "26.12.1"]',
            "[node24Version, ...newVersions]",
          ),
      }),
    ).toThrow("Unsupported frozen qualification cross-OS Node matrix");
  });

  it.each([
    ["cross_os_release_checks / Windows / packaged fresh", "missing"],
    ["cross_os_release_checks / Windows / packaged fresh", "skipped"],
    ["Run package acceptance / Package integrity", "missing"],
    ["Run package acceptance / Package integrity", "skipped"],
    ["cross_os_release_checks / macOS / installer fresh", "missing"],
    ["cross_os_release_checks / Linux / packaged upgrade", "skipped"],
    ["Run QA Lab runtime-pair lane (soak)", "missing", "releaseChecksIndependent"],
    ["Run QA Lab runtime-pair lane (core)", "skipped", "releaseChecksIndependent"],
    ["Run package acceptance / npm 12 install.sh acceptance", "missing"],
    [
      "Run package acceptance / Docker product acceptance (artifact-only) / Docker E2E targeted lanes (plugin-update)",
      "skipped",
    ],
    ["Run Docker release-path validation / Docker E2E (core)", "missing"],
    ["Run Docker release-path validation / Docker E2E (plugins/runtime install H)", "skipped"],
    [
      "Run repo/live E2E validation / Native live suites (Native live agents)",
      "missing",
      "releaseChecksIndependent",
    ],
  ])(
    "rejects %s when %s despite a successful aggregate",
    async (jobName, disposition, role = "releaseChecksCandidate") => {
      const f = recoveryConsumptionFixture(recoveryCandidateFixture("full"), (child) => {
        if (child.role !== role) {
          return;
        }
        // These are actual Q workflow leaf names, not additional requiredJobs
        // invented by the test. Keep the real admitted aggregate successful.
        const index = child.jobs.findIndex((job) => job.name === jobName);
        expect(index).toBeGreaterThanOrEqual(0);
        if (disposition === "missing") {
          child.jobs.splice(index, 1);
        } else {
          child.jobs[index]!.conclusion = "skipped";
        }
      });
      const childRun = f.recovery.children[role]!;
      expect(
        f.jobs.get(childRun.runId)!.find((job) => job.name === "Verify release checks"),
      ).toMatchObject({ conclusion: "success" });
      expect(() =>
        validateQualificationChildCompleteness({
          role,
          inputs: childRun.inputs,
          jobs: f.jobs.get(childRun.runId),
          getSource: (path) => readFileSync(path, "utf8"),
        }),
      ).toThrow("required job did not succeed exactly once: " + jobName);
      // A real resealed receipt agrees with raw GitHub jobs. Rejection must come
      // from completeness policy, not a digest or composite-evidence mismatch.
      const outcome = await (async () => {
        const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
        f.manifest.retainedPublicationPayloads = original.publication.payloads;
        return authenticateFullReleaseValidationEvidence(
          {
            ...consumptionOptions(f.direct),
            run: f.run,
            manifest: f.manifest,
            expectedRunId: "900",
          },
          f.client,
        );
      })().then(
        () => "accepted incomplete evidence",
        (error: unknown) => "rejected: " + String(error),
      );
      expect(outcome).not.toBe("accepted incomplete evidence");
    },
  );

  it.each([
    ["required release-check job", "releaseChecksCandidate", "Verify release checks"],
    ["performance artifact-only guard", "productPerformance", "Verify artifact-only report mode"],
  ])("rejects a sealed child missing its %s", async (_label, role, jobName) => {
    const f = recoveryConsumptionFixture(recoveryCandidateFixture("full"), (child) => {
      if (child.role === role) {
        child.jobs.find((job) => job.name === jobName)!.name = "Unrelated successful workload";
      }
    });
    await expect(
      verifyOriginalReceiptQualification(f.recovery, { client: f.client }),
    ).rejects.toThrow("required job did not succeed exactly once: " + jobName);
  });

  it.each([
    "soak",
    "profile",
    "platform coverage",
    "performance inputs",
    "performance publication",
  ])("rejects authenticated child evidence with changed %s", async (fault) => {
    const f = recoveryConsumptionFixture(recoveryCandidateFixture("full"), (child) => {
      if (child.role === "releaseChecksCandidate") {
        if (fault === "soak") {
          child.inputs.run_release_soak = "false";
        }
        if (fault === "profile") {
          child.inputs.release_profile = "beta";
        }
        if (fault === "platform coverage") {
          child.inputs.cross_os_suite_filter = "linux";
        }
      }
      if (child.role === "productPerformance") {
        if (fault === "performance inputs") {
          child.inputs.publish_reports = "true";
        }
        if (fault === "performance publication") {
          child.jobs.push({ ...child.jobs[0]!, id: 19000, name: "Publish performance report" });
        }
      }
    });
    await expect(
      verifyOriginalReceiptQualification(f.recovery, { client: f.client }),
    ).rejects.toThrow(
      fault === "performance publication"
        ? "performance report publisher was not skipped"
        : /input/u,
    );
  });

  it("preserves the authenticated original parent failure and rejects its replacement attempt", async () => {
    const f = recoveryConsumptionFixture(recoveryCandidateFixture("stable"));
    const id = f.recovery.originalParent.runId;
    f.runs.get(id)!.conclusion = "failure";
    const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
    expect(original.originalParent.conclusion).toBe("failure");
    await revalidateReceiptRecoveryRuns(
      f.recovery,
      f.client,
      original.children,
      original.originalParent,
    );
    f.runs.set(id, { ...f.runs.get(id)!, conclusion: "success" });
    await expect(
      revalidateReceiptRecoveryRuns(
        f.recovery,
        f.client,
        original.children,
        original.originalParent,
      ),
    ).rejects.toThrow("current attempt changed: " + id);
    f.runs.set(id, { ...f.runs.get(id)!, conclusion: "failure", run_attempt: 2 });
    await expect(
      verifyOriginalReceiptQualification(f.recovery, { client: f.client }),
    ).rejects.toThrow("original parent differs");
  });

  it("retains raw waived performance failure through authenticated publication consumption", async () => {
    const f = recoveryConsumptionFixture(
      recoveryCandidateFixture("stable", { version: "2026.11.4" }),
      (child) => {
        if (child.role !== "productPerformance") {
          return;
        }
        child.run.conclusion = "failure";
        child.jobs.find((job) => job.name === "Kova mock provider performance")!.conclusion =
          "failure";
      },
    );
    const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
    f.manifest.retainedPublicationPayloads = original.publication.payloads;
    Object.assign(f.manifest, { waivers: original.children.flatMap((child) => child.waivers) });
    const performance = original.children.find((child) => child.role === "productPerformance")!;
    expect(performance.conclusion).toBe("failure");
    expect(
      performance.receipt.jobs.find(
        (job: { name: string }) => job.name === "Kova mock provider performance",
      ),
    ).toMatchObject({ conclusion: "failure" });
    expect(performance.waivers).toHaveLength(1);
    const consumed = await authenticateFullReleaseValidationEvidence(
      {
        ...consumptionOptions(f.direct),
        run: f.run,
        manifest: f.manifest,
        expectedRunId: "900",
      },
      f.client,
    );
    expect(
      consumed.evidence.children.find(
        (child: { role: string }) => child.role === "productPerformance",
      ),
    ).toMatchObject({ conclusion: "failure" });
    expect(
      consumed.forPublication({
        ...consumptionOptions(f.direct),
        run: f.run,
        manifest: f.manifest,
        expectedRunId: "900",
      }).source,
    ).toBe("receipt-backed-recovery-v1");
  });

  it.each([
    ["admission", "Qualification operator no longer has repository qualification authority"],
    ["candidate", "aggregate changed the original candidate"],
    ["run attempt", "current successful attempt"],
    ["workflow", "full release parent run binding mismatch"],
    ["artifact", "expired"],
    [
      "recovery authority",
      "Qualification operator no longer has repository qualification authority",
    ],
    ["waiver", "aggregate waivers differ"],
    ["missing admission", "unexpected request fields"],
    ["forged admission", "artifact"],
    ["wrong run", "runId does not match"],
    ["wrong aggregate attempt", "manifest artifact is not compatible"],
    ["missing recovery authentication", "authenticated operator"],
    ["artifact bytes", "artifact"],
    ["missing child", "exactly the admitted child roles"],
    ["uncovered failure", "live composite workload"],
  ])("rejects changed %s", async (fault, message) => {
    const f = recoveryConsumptionFixture();
    const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
    f.manifest.retainedPublicationPayloads = original.publication.payloads;
    if (fault === "admission") {
      f.direct.admission.authority.permission = "read";
    }
    if (fault === "candidate") {
      f.recovery.candidateBinding.request.targetSha = "f".repeat(40);
    }
    if (fault === "run attempt") {
      f.runs.get(f.recovery.children.normalCi!.runId)!.run_attempt = 2;
    }
    if (fault === "workflow") {
      f.run.path = ".github/workflows/ci.yml";
    }
    if (fault === "artifact") {
      f.metadata.get("103")!.expired = true;
    }
    if (fault === "recovery authority") {
      f.recoveryAuthority.permission = "read";
    }
    if (fault === "waiver") {
      Object.assign(f.manifest, { waivers: [{ reason: "caller supplied waiver" }] });
    }
    if (fault === "missing admission") {
      Reflect.deleteProperty(f.recovery, "qualificationAdmission");
    }
    if (fault === "forged admission") {
      f.recovery.qualificationAdmission.artifactDigest = "sha256:" + "f".repeat(64);
    }
    if (fault === "wrong run") {
      f.run.id = 901;
    }
    if (fault === "wrong aggregate attempt") {
      f.run.run_attempt = 2;
    }
    if (fault === "missing recovery authentication") {
      Reflect.deleteProperty(f.run, "triggering_actor");
    }
    if (fault === "artifact bytes") {
      f.archives.set(
        f.manifest.publicationAdmission.binding.artifact.id,
        Buffer.from("tampered observation artifact"),
      );
    }
    if (fault === "missing child") {
      Reflect.deleteProperty(f.recovery.children, "normalCi");
      Reflect.deleteProperty(f.manifest.childRuns, "normalCi");
    }
    if (fault === "uncovered failure") {
      f.jobs.get(f.recovery.children.normalCi!.runId)![0]!.conclusion = "failure";
    }
    await expect(
      authenticateFullReleaseValidationEvidence(
        {
          ...consumptionOptions(f.direct),
          run: f.run,
          manifest: f.manifest,
          expectedRunId: "900",
        },
        f.client,
      ),
    ).rejects.toThrow(message);
  });
});
