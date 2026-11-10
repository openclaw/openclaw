import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNpmCliProcessFixture } from "./plugin-npm-cli-process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Distinct processes are essential: an in-memory client spy misses the retained
// publication owner and cannot establish that the uploaded carrier is sufficient.
// Only two identical consumers run; the 101-consumer report below is extrapolated.
it("replays recovery-backed preview evidence through two CLI consume/authorize pairs", async () => {
  const f = await createNpmCliProcessFixture(tempDirs.make("npm-cli-recovery-"));
  const success = (result: ReturnType<typeof f.preview>) => {
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  };
  success(f.preview());
  const carrier = f.sealCarrier();
  expect(carrier.binding.frvRunId).toBe("9900");
  expect(carrier.binding.childRunId).toBe("800");
  expect(carrier.binding.childRunAttempt).toBe(2);
  expect(f.recovery.manifest.receiptRecovery.originalParent.runId).toBe(f.f.runId);
  expect(f.recovery.manifest.workflowSha).not.toBe(f.f.q);

  for (const suffix of ["alpha", "beta"]) {
    // Same package and inputs in every pair: beta denotes another process, not
    // another workload. This makes the 101-pair arithmetic directly comparable.
    const consumed = f.consume("consume-" + suffix, 0);
    success(consumed);
    expect(readFileSync(consumed.output, "utf8")).toContain("package_name=@openclaw/alpha\n");
    success(f.authorize("authorize-" + suffix));
  }
  const records = f.records();
  const requests = (invocation: string) =>
    records.filter((row) => row.kind === "request" && row.invocation === invocation);
  const phases = ["preview", "consume-alpha", "authorize-alpha", "consume-beta", "authorize-beta"];
  const starts = records.filter(
    (row) => row.kind === "entrypoint" && phases.includes(row.invocation),
  );
  expect(starts).toHaveLength(5);
  expect(new Set(starts.map((row) => row.pid)).size).toBe(5);

  const counts = Object.fromEntries(phases.map((name) => [name, requests(name).length]));
  // Authenticate the carrier producer before trusting anything inside the carrier.
  const carrierJobsRoute = "actions/runs/800/attempts/2/jobs?per_page=100";
  const replayRoutes = new Set(carrier.entries.map(([route]: [string, unknown]) => route));
  const categoryCounts = (name: string) => {
    const categories = { live: 0, immutable: 0, carrier: 0, selectedPackage: 0 };
    for (const { route = "" } of requests(name)) {
      if (route === "actions/artifacts/900/zip") {
        categories.carrier += 1;
      } else if (route === "actions/artifacts/9002/zip") {
        categories.selectedPackage += 1;
      } else if (route === carrierJobsRoute) {
        categories.live += 1;
      } else if (
        replayRoutes.has(route) ||
        route.endsWith("/zip") ||
        route.startsWith("contents/") ||
        route.endsWith("/logs") ||
        /\/attempts\/[0-9]+\/jobs\?/u.test(route)
      ) {
        categories.immutable += 1;
      } else {
        categories.live += 1;
      }
    }
    return categories;
  };
  const categoriesByProcess = Object.fromEntries(
    phases.map((name) => [name, categoryCounts(name)]),
  );
  const replayPair = counts["consume-alpha"]! + counts["authorize-alpha"]!;
  // Emit observed counts before later assertions. The 101-pair calculation is
  // explicitly extrapolated, not a claim that 202 processes have been run.
  const workload101 = Object.fromEntries(
    (["live", "immutable", "carrier", "selectedPackage"] as const).map((category) => [
      category,
      categoriesByProcess.preview![category] +
        101 *
          (categoriesByProcess["consume-alpha"]![category] +
            categoriesByProcess["authorize-alpha"]![category]),
    ]),
  );
  console.log(
    JSON.stringify({
      scenario: "receipt-recovery-cli",
      measuredConsumers: 2,
      requestsByProcess: counts,
      categoriesByProcess,
      observed: { previewPlusTwoPairs: phases.reduce((sum, name) => sum + counts[name]!, 0) },
      extrapolated101IdenticalConsumers: {
        notExecuted: true,
        consumeAndAuthorizeRequestsPerConsumer: replayPair,
        previewPlusConsumeAndAuthorizeRequests: counts.preview! + 101 * replayPair,
        categories: workload101,
      },
    }),
  );
  expect(counts["consume-beta"]).toBe(counts["consume-alpha"]);
  expect(counts["authorize-beta"]).toBe(counts["authorize-alpha"]);

  const immutableAuthorityRoutes = [
    "actions/runs/40/attempts/1",
    "compare/" + f.f.p + "..." + f.f.p + "?per_page=1&page=2",
  ];
  for (const route of immutableAuthorityRoutes) {
    expect(replayRoutes.has(route), "preview omitted " + route).toBe(true);
  }
  const previewRoutes = new Set(requests("preview").map((row) => row.route));
  for (const id of [104, ...f.recovery.retainedArchiveIds]) {
    expect(
      previewRoutes.has("actions/artifacts/" + id + "/zip"),
      "retained archive " + id + " must be acquired by preview",
    ).toBe(true);
    expect(
      carrier.entries.some(
        ([route]: [string, unknown]) => route === "actions/artifacts/" + id + "/zip",
      ),
    ).toBe(true);
  }
  for (const name of phases.slice(1)) {
    // Bound all immutable work, including routes not listed in the fixture inventory.
    expect(categoriesByProcess[name]!.immutable, name + " reacquired immutable evidence").toBe(0);
    const calls = requests(name);
    for (const route of immutableAuthorityRoutes) {
      expect(
        calls.filter((row) => row.route === route),
        name + " reacquired " + route,
      ).toEqual([]);
    }
    expect(calls.filter((row) => row.route === carrierJobsRoute)).toHaveLength(1);
    expect(calls.filter((row) => row.route === "actions/artifacts/900/zip")).toHaveLength(1);
    expect(calls.filter((row) => row.route === "actions/artifacts/9002/zip")).toHaveLength(
      name.startsWith("consume") ? 1 : 0,
    );
    expect(calls.filter((row) => row.route === "actions/artifacts/9003/zip")).toHaveLength(0);
    for (const id of f.recovery.immutableArchiveIds) {
      const downloads = calls.filter((row) => row.route === "actions/artifacts/" + id + "/zip");
      expect.soft(downloads, name + " reacquired immutable " + id).toHaveLength(0);
    }
    expect(
      calls.filter((row) => row.route?.startsWith("contents/") || row.route?.endsWith("/logs")),
    ).toHaveLength(0);
    // This includes full-release-artifacts reads, not merely the generic client:
    // the producer's jobs replay, while current runs and artifact metadata do not.
    expect(
      calls.filter((row) => /actions\/runs\/600[12]\/attempts\/1\/jobs/u.test(row.route ?? "")),
    ).toHaveLength(0);
    for (const route of [
      "actions/artifacts/6201",
      "actions/artifacts/6301",
      "actions/artifacts/91",
      "actions/artifacts/70",
      "actions/runs/40",
      "actions/runs/6001",
      "actions/runs/6002",
      "actions/runs/9900",
      "actions/runs/910",
      "actions/runs/5001/artifacts?per_page=100&page=1",
      "collaborators/release-operator/permission",
    ]) {
      const refreshed = calls.some((row) => row.route === route);
      expect(refreshed, name + " did not refresh " + route).toBe(true);
    }
    expect(calls.some((row) => row.route?.startsWith("git/ref/"))).toBe(true);
  }
  for (const id of f.recovery.metadataOnlyPayloadIds) {
    for (const name of phases) {
      const downloaded = requests(name).some(
        (row) => row.route === "actions/artifacts/" + id + "/zip",
      );
      expect(downloaded).toBe(false);
    }
  }

  const reject = (invocation: string, pattern: RegExp, authorize = false) => {
    f.save();
    const result = authorize ? f.authorize(invocation) : f.consume(invocation, 0);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(pattern);
    expect(result.stderr).not.toContain("Unconfigured external fixture request");
    expect(existsSync(result.output)).toBe(false);
  };
  // Keep the authentic carrier fixed while current remote state changes.
  for (const [route, changed, pattern] of [
    ["actions/artifacts/6201", { expired: true }, /expired|artifact/iu],
    ["actions/runs/6002", { run_attempt: 2 }, /attempt|identity/iu],
    ["actions/runs/9900", { run_attempt: 2 }, /attempt|changed|aggregate artifact is missing/iu],
    ["actions/runs/800", { run_attempt: 3 }, /current trusted publication attempt/iu],
    [
      "collaborators/release-operator/permission",
      { permission: "read" },
      /no longer has repository qualification authority/iu,
    ],
  ] as const) {
    const original = f.responses[route]!;
    f.json(route, { ...JSON.parse(original.data), ...changed });
    reject("reject-" + route.replaceAll("/", "-"), pattern, true);
    f.responses[route] = original;
  }
  const carrierJobs = f.responses[carrierJobsRoute]!;
  const failedProducer = JSON.parse(carrierJobs.data);
  failedProducer.jobs[0].conclusion = "failure";
  f.json(carrierJobsRoute, failedProducer);
  reject("failed-carrier-producer", /producer|successful|success/iu, true);
  f.responses[carrierJobsRoute] = carrierJobs;
  // Changes occurring after the last package acquisition must be observed at
  // the consume effect boundary, not only when the carrier was authenticated.
  const selectedRoute = "actions/artifacts/9002/zip";
  const selected = f.responses[selectedRoute]!;
  const authorityRoute = "collaborators/release-operator/permission";
  const authority = f.responses[authorityRoute]!;
  f.responses[selectedRoute] = {
    ...selected,
    after: {
      route: authorityRoute,
      value: {
        encoding: "utf8",
        data: JSON.stringify({
          ...JSON.parse(f.responses[authorityRoute]!.data),
          permission: "read",
        }),
      },
    },
  };
  reject("revoked-after-package-read", /no longer has repository qualification authority/iu);
  f.responses[selectedRoute] = selected;
  f.responses[authorityRoute] = authority;
  const archive = Buffer.from(selected.data, "base64");
  archive[0] = archive[0]! ^ 1;
  f.bytes(selectedRoute, archive);
  reject("corrupt-selected-bytes", /digest|sha.?256/iu);
  f.responses[selectedRoute] = selected;

  // The candidate seal is also acquired through the authenticated replay owner.
  // Corrupting it must fail preview instead of silently bypassing the archive.
  const candidateRoute = "actions/artifacts/104/zip";
  const candidate = Buffer.from(f.responses[candidateRoute]!.data, "base64");
  candidate[0] = candidate[0]! ^ 1;
  f.bytes(candidateRoute, candidate);
  f.save();
  const invalidCandidate = f.preview("corrupt-candidate");
  expect(invalidCandidate.error, invalidCandidate.stderr).toBeUndefined();
  expect(invalidCandidate.status).not.toBe(0);
  expect(invalidCandidate.stderr).toMatch(/digest|sha.?256/iu);
  expect(invalidCandidate.stderr).not.toContain("Unconfigured external fixture request");
}, 240_000);
