import { existsSync, readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNpmCliProcessFixture } from "./plugin-npm-cli-process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses fanout before writing its matrix when the current quota cannot cover the request ceilings", async () => {
  const f = await createNpmCliProcessFixture(tempDirs.make("npm-cli-budget-"), "", 98);
  const result = f.preview();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("requires 11608 requests for 98 packages; 5000 remain");
  expect(existsSync(result.output)).toBe(false);
  expect(existsSync(f.previewManifest)).toBe(false);
});

// This release-size proof deliberately crosses 202 independent CLI processes:
// preview admission alone cannot prove that the enforced transport caps suffice.
it.each([true, false])(
  "runs the full 101-package flow within 12k requests (parent=%s)",
  async (parent) => {
    const f = await createNpmCliProcessFixture(
      tempDirs.make("npm-cli-full-budget-"),
      "",
      101,
      parent,
    );
    f.json("/rate_limit", { resources: { core: { remaining: 12000, reset: 4_070_908_800 } } });
    f.save();
    const preview = f.preview();
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(readFileSync(f.previewManifest, "utf8")).packages).toHaveLength(101);
    const admission = preview.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"githubPublicationBudget"'))
      .map((line) => JSON.parse(line).githubPublicationBudget)[0];
    expect(admission.required).toBe(11932);
    f.sealCarrier();
    for (let index = 0; index < 101; index += 1) {
      for (const result of [
        f.consume(`consume-${index}`, index),
        f.authorize(`authorize-${index}`, true, index),
      ]) {
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const accounting = result.stderr
          .split("\n")
          .filter((line) => line.startsWith('{"githubRequestAccounting"'))
          .map((line) => JSON.parse(line).githubRequestAccounting)
          .find((entry) => entry.scope === "prepared-npm-command");
        expect(accounting.limit).toBe(54);
        expect(accounting.used).toBeLessThanOrEqual(accounting.limit);
      }
    }
    const records = f.records();
    expect(records.filter((row) => row.kind === "entrypoint")).toHaveLength(203);
    const requests = records.filter((row) => row.kind === "request").length;
    expect(requests).toBeLessThanOrEqual(12000);
    console.info(JSON.stringify({ fullReleaseRequestProof: { packages: 101, requests } }));
  },
  300_000,
);

it.each([true, false])(
  "retains CLI final authority after sharing reads (parent=%s)",
  async (parent) => {
    const f = await createNpmCliProcessFixture(tempDirs.make("npm-cli-ordinary-"), "", 2, parent);
    expect(f.preview().status).toBe(0);
    f.sealCarrier();
    expect(f.consume("consume", 0).status).toBe(0);
    expect(f.authorize("authorize").status).toBe(0);
    // Different packages share the exact authenticated graph, not package bytes.
    const beta = f.consume("consume-beta", 1);
    expect(beta.status, beta.stderr).toBe(0);
    expect(readFileSync(beta.output, "utf8")).toContain("package_name=@openclaw/beta\n");
    const betaAuthorization = f.authorize("authorize-beta", true, 1);
    expect(betaAuthorization.status, betaAuthorization.stderr).toBe(0);
    const counts = Object.fromEntries(
      ["preview", "consume", "authorize", "consume-beta", "authorize-beta"].map((phase) => [
        phase,
        f.records().filter((row) => row.kind === "request" && row.invocation === phase).length,
      ]),
    );
    // Preview acquires the waiver policy and stable-client qualification evidence.
    // Every process revalidates the stable-client run before proceeding.
    expect(counts).toEqual({
      preview: 57,
      consume: 26,
      authorize: 23,
      "consume-beta": 26,
      "authorize-beta": 23,
    });
    console.log(JSON.stringify({ scenario: "ordinary-cli", requestsByProcess: counts }));
    // Carrier replay avoids downloading immutable qualification evidence again.
    for (const invocation of ["consume", "authorize", "consume-beta", "authorize-beta"]) {
      const calls = f
        .records()
        .filter((row) => row.kind === "request" && row.invocation === invocation);
      for (const id of [70, 91, 92, 9001]) {
        expect(calls.some((row) => row.route === "actions/artifacts/" + id + "/zip")).toBe(false);
      }
    }
    const selectedRoute = "actions/artifacts/9002/zip";
    const selected = f.responses[selectedRoute]!;
    const ref = "git/ref/" + f.f.publisherFullRef.slice(5);
    // Refresh authority after package download, rather than trusting the preview's verdict.
    for (const [route, changed, pattern] of [
      [
        "collaborators/release-operator/permission",
        { permission: "read" },
        /permission|write|authority/iu,
      ],
      [ref, { object: { type: "commit", sha: "f".repeat(40) } }, /ref|SHA|identity/iu],
      ["actions/runs/40", { run_attempt: 2 }, /attempt|changed|identity/iu],
    ] as const) {
      const original = f.responses[route]!;
      f.responses[selectedRoute] = {
        ...selected,
        after: {
          route,
          value: {
            encoding: "utf8",
            data: JSON.stringify({ ...JSON.parse(original.data), ...changed }),
          },
        },
      };
      f.save();
      const revoked = f.consume("changed-after-download-" + route.replaceAll("/", "-"), 0);
      expect(revoked.status, revoked.stderr).not.toBe(0);
      expect(revoked.stderr).toMatch(pattern);
      expect(revoked.stderr).not.toContain("Unconfigured external fixture request");
      expect(existsSync(revoked.output)).toBe(false);
      f.responses[route] = original;
    }
    f.responses[selectedRoute] = selected;
    const archive = Buffer.from(selected.data, "base64");
    archive[0] = archive[0]! ^ 1;
    f.bytes(selectedRoute, archive);
    f.save();
    const corrupt = f.consume("corrupt-selected-bytes", 0);
    expect(corrupt.status, corrupt.stderr).not.toBe(0);
    expect(corrupt.stderr).toMatch(/digest|sha.?256/iu);
    expect(existsSync(corrupt.output)).toBe(false);
  },
  60_000,
);

// Parent dispatch has no preview carrier.
it.each(["authorize", "consume"])(
  "%s reuses carrierless evidence",
  async (command) => {
    const f = await createNpmCliProcessFixture(
      tempDirs.make("npm-parent-authorize-"),
      "@openclaw/alpha",
    );
    const run = (invocation: string) =>
      command === "consume"
        ? f.consume(invocation, 0, false)
        : f.run(invocation, ["authorize"], false);
    const result = run("parent");
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const calls = f
      .records()
      .filter((row) => row.kind === "request" && row.invocation === "parent");
    const accounting = result.stderr
      .split("\n")
      .find((line) => line.startsWith('{"githubRequestAccounting"'));
    if (!accounting) {
      throw new Error("Missing publication request accounting");
    }
    expect(JSON.parse(accounting).githubRequestAccounting).toEqual({
      scope: "prepared-npm-command",
      command,
      limit: 256,
      used: calls.length,
    });
    expect(calls.length).toBeLessThan(256);
    expect(existsSync(f.previewManifest)).toBe(false);
    expect(calls.some((row) => row.route === "actions/artifacts/900/zip")).toBe(false);
    for (const id of command === "consume" ? [70, 91, 92, 9001] : [70, 91, 92]) {
      expect(calls.filter((row) => row.route === "actions/artifacts/" + id + "/zip")).toHaveLength(
        1,
      );
    }
    console.log(
      JSON.stringify({ scenario: command + "-no-carrier", requests: calls.length, limit: 256 }),
    );

    // Change authority at the last immutable acquisition, before the final live sweep.
    const trigger = calls.findLast((row) => row.route?.endsWith("/zip"))?.route;
    if (!trigger) {
      throw new Error("Missing immutable acquisition boundary");
    }
    const originalTrigger = f.responses[trigger]!;
    const ref = "git/ref/" + f.f.publisherFullRef.slice(5);
    for (const [route, changed, pattern] of [
      [
        "collaborators/release-operator/permission",
        { permission: "read" },
        /authority|permission/iu,
      ],
      [ref, { object: { type: "commit", sha: "f".repeat(40) } }, /ref|SHA|identity/iu],
      ["actions/runs/40", { run_attempt: 2 }, /attempt|changed|identity/iu],
    ] as const) {
      const original = f.responses[route]!;
      const response: typeof originalTrigger = {
        ...originalTrigger,
        after: {
          route,
          value: {
            encoding: "utf8" as const,
            data: JSON.stringify({ ...JSON.parse(original.data), ...changed }),
          },
        },
      };
      f.responses[trigger] = response;
      f.save();
      const rejected = run("revoked-" + route.replaceAll("/", "-"));
      expect(rejected.error, rejected.stderr).toBeUndefined();
      expect(rejected.status, route + "\n" + rejected.stderr).not.toBe(0);
      expect(rejected.stderr).toMatch(pattern);
      expect(rejected.stderr).not.toContain("Unconfigured external fixture request");
      f.responses[trigger] = originalTrigger;
      f.responses[route] = original;
    }
  },
  120_000,
);

it("keeps non-FRV preparation carrierless with the full admission budget", async () => {
  const f = await createNpmCliProcessFixture(tempDirs.make("npm-no-frv-"), "", 2, false);
  Object.assign(f.env, {
    PREPARED_NPM_FRV_RUN_ID: "",
    PREPARED_NPM_FRV_RUN_ATTEMPT: "",
    GITHUB_WORKFLOW_SHA: f.f.q,
  });
  const result = f.preview();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('"perPackage":512');
  expect(readFileSync(result.output, "utf8")).toContain("evidence_attempt=\n");
  expect(existsSync(f.evidence)).toBe(false);
});

it.each([true, false])("binds every handoff to its exact operation (parent=%s)", async (parent) => {
  const f = await createNpmCliProcessFixture(
    tempDirs.make("npm-binding-"),
    "@openclaw/alpha",
    2,
    parent,
  );
  const preview = f.preview();
  expect(preview.status, preview.stderr).toBe(0);
  expect(readFileSync(preview.output, "utf8")).toContain("evidence_attempt=2\n");
  const payload = f.sealCarrier();
  expect(payload.binding.parentRunId).toBe(parent ? "700" : null);
  expect(payload.binding.parentRunAttempt).toBe(parent ? 1 : null);
  const original = { ...f.env };
  const changes: Record<string, string>[] = [
    {
      PREPARED_NPM_PARENT_RUN_ID: parent ? "" : "700",
      PREPARED_NPM_PARENT_RUN_ATTEMPT: parent ? "" : "1",
    },
    { PREPARED_NPM_PARENT_RUN_ID: "700", PREPARED_NPM_PARENT_RUN_ATTEMPT: "" },
    { PREPARED_NPM_PARENT_RUN_ID: "", PREPARED_NPM_PARENT_RUN_ATTEMPT: "1" },
    { PREPARED_NPM_FRV_RUN_ID: "99" },
    { PREPARED_NPM_FRV_RUN_ATTEMPT: "2" },
    { GITHUB_RUN_ATTEMPT: "1" },
    { PREPARED_NPM_PLUGINS: "@openclaw/beta" },
    { PREPARED_NPM_SELECTION_MODE: "all-publishable" },
    { PREPARED_NPM_DIST_TAG: "extended-stable" },
    {
      PREPARED_NPM_ARTIFACT: JSON.stringify({
        ...JSON.parse(f.env.PREPARED_NPM_ARTIFACT),
        artifactId: 123,
      }),
    },
  ];
  for (const [index, change] of changes.entries()) {
    Object.assign(f.env, original, change);
    const result = f.consume("mismatch-" + index, 0);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/handoff|publication attempt/iu);
    expect(result.stderr).not.toContain("Unconfigured external fixture request");
    expect(existsSync(result.output)).toBe(false);
  }
  Object.assign(f.env, original);
  const valid = f.consume("unchanged", 0);
  expect(valid.status, valid.stderr).toBe(0);
});

it("charges direct carrier retries and refuses pagination beyond the transport ceiling", async () => {
  const f = await createNpmCliProcessFixture(tempDirs.make("npm-retry-budget-"), "", 2, false);
  expect(f.preview().status).toBe(0);
  f.sealCarrier();
  const route = "actions/runs/5001/artifacts?page=1&per_page=100";
  const original = f.responses[route]!;
  f.responses[route] = { ...original, status: 503, after: { route, value: original } };
  f.save();
  const retried = f.consume("retried", 0);
  expect(retried.status, retried.stderr).toBe(0);
  const requests = f
    .records()
    .filter((row) => row.invocation === "retried" && row.kind === "request");
  expect(
    requests.filter((row) => row.route?.startsWith("actions/runs/5001/artifacts?")),
  ).toHaveLength(2);
  expect(requests).toHaveLength(27);
  expect(retried.stderr).toContain('"limit":54,"used":27');
  expect(f.records().some((row) => row.invocation === "retried" && row.kind === "retry-wait")).toBe(
    true,
  );

  // Pages and their retries share the same enforced cap as preview admission.
  // Even a bounded inventory cannot silently consume the authority headroom.
  for (let page = 1; page <= 10; page += 1) {
    const pageRoute = "actions/runs/5001/artifacts?page=" + page + "&per_page=100";
    f.json(pageRoute, {
      total_count: 1000,
      artifacts: Array.from({ length: 100 }, (_, index) =>
        page === 1 && index === 0
          ? JSON.parse(original.data).artifacts[0]
          : { id: 100000 + page * 100 + index },
      ),
    });
    const value = f.responses[pageRoute]!;
    f.responses[pageRoute] = {
      ...value,
      status: 503,
      after: {
        route: pageRoute,
        value: {
          ...value,
          status: 503,
          after: {
            route: pageRoute,
            value: { ...value, status: 503, after: { route: pageRoute, value } },
          },
        },
      },
    };
  }
  f.save();
  const exhausted = f.consume("exhausted", 0);
  expect(exhausted.status, exhausted.stderr).toBe(1);
  expect(exhausted.stderr).toContain("request budget exhausted (54)");
  expect(
    f.records().filter((row) => row.invocation === "exhausted" && row.kind === "request"),
  ).toHaveLength(54);
  expect(existsSync(exhausted.output)).toBe(false);
});
