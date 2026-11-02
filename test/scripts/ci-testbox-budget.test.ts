import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertFreshTestboxAdmission,
  boundedTestboxIdleMinutes,
  planTestboxAdmission,
} from "../../scripts/ci-testbox-budget.mjs";

const now = Date.parse("2026-10-01T12:00:00Z");
const request = {
  profile: "check",
  id: "tbx_example",
  createdAt: "2026-10-01T11:55:00Z",
};
const planAdmission = (overrides: Partial<Parameters<typeof planTestboxAdmission>[0]> = {}) =>
  planTestboxAdmission({ ...request, ...overrides }, now);

function runModule(source: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    env,
  });
}

describe("Testbox spending admission", () => {
  it("shares one bounded pool across profiles without changing a lease's slot", () => {
    const groups = new Set<string>();
    for (let index = 0; index < 256; index++) {
      const lease = { ...request, id: `tbx_example_${index}` };
      const group = planTestboxAdmission(lease, now).group;
      expect(group).toMatch(/^openclaw-testbox-budget-v1-(?:[0-9]|[12][0-9]|3[01])$/);
      expect(planTestboxAdmission({ ...lease, profile: "build" }, now).group).toBe(group);
      groups.add(group);
    }
    expect(groups.size).toBe(32);
  });

  it("defaults routine proof to 16-class and requires the high-memory profile for 32-class", () => {
    expect(planAdmission().runner).toBe("blacksmith-16vcpu-ubuntu-2404");
    expect(() => planAdmission({ runner: "blacksmith-32vcpu-ubuntu-2404" })).toThrow(/not allowed/);
    const groups = new Set<string>();
    for (let index = 0; index < 128; index++) {
      const plan = planAdmission({ profile: "check-memory", id: `tbx_memory_${index}` });
      expect(plan.runner).toBe("blacksmith-32vcpu-ubuntu-2404");
      expect(plan.group).toMatch(/^openclaw-testbox-budget-v1-[0-3]$/);
      groups.add(plan.group);
    }
    expect(groups.size).toBe(4);
  });

  it.each([0, 241, 1.5])("rejects an unbounded runtime: %s", (minutes) => {
    expect(() => planAdmission({ minutes })).toThrow(/runtime/);
  });

  it("defaults routine proof to one hour and preserves explicit long-proof requests", () => {
    const workflow = parse(readFileSync(".github/workflows/ci-check-testbox.yml", "utf8"));
    const dispatchDefault = workflow.on.workflow_dispatch.inputs.timeout_minutes.default;
    expect(planAdmission({ minutes: dispatchDefault }).minutes).toBe(60);
    expect(planAdmission().minutes).toBe(60);
    expect(planAdmission({ minutes: "" }).minutes).toBe(60);
    expect(planAdmission({ profile: "check-memory" }).minutes).toBe(240);
    expect(planAdmission({ minutes: 240 }).minutes).toBe(240);
  });

  it("allows approved Windows sizes and refuses arbitrary dispatch labels", () => {
    const runner = "blacksmith-8vcpu-windows-2025";
    expect(planAdmission({ profile: "windows", runner }).runner).toBe(runner);
    expect(() => planAdmission({ profile: "windows", runner: "self-hosted" })).toThrow(
      /not allowed/,
    );
  });

  it("expires abandoned queue entries before hydration, including the deadline itself", () => {
    const plan = planAdmission();
    expect(
      planTestboxAdmission(request, Date.parse(request.createdAt) + 35 * 60_000).expires_at,
    ).toBe(plan.expires_at);
    expect(() => assertFreshTestboxAdmission(plan.expires_at, plan.expires_at - 1)).not.toThrow();
    expect(() => assertFreshTestboxAdmission(plan.expires_at, plan.expires_at)).toThrow(/expired/);
    expect(() => planTestboxAdmission(request, plan.expires_at)).toThrow(/expired/);
    expect(() => planAdmission({ createdAt: "unknown" })).toThrow(/invalid/);
  });

  it("caps idle requests while retaining shorter provider deadlines", () => {
    expect(boundedTestboxIdleMinutes("90\n")).toBe(15);
    expect(boundedTestboxIdleMinutes("5\n")).toBe(5);
    expect(() => boundedTestboxIdleMinutes("0")).toThrow(/invalid/);
  });

  it("configures idle time after an admitted checkout crosses the queue deadline", () => {
    const script = resolve("scripts/ci-testbox-budget.mjs");
    const result = runModule(
      `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          import { pathToFileURL } from "node:url";
          const read = fs.readFileSync;
          fs.readFileSync = (path, ...args) =>
            path === "/tmp/.testbox/idle_timeout" ? "90\\n" : read(path, ...args);
          fs.writeFileSync = (path, value) => {
            assert.equal(path, "/tmp/.testbox/idle_timeout");
            assert.equal(value, "15\\n");
            console.log("idle setting updated");
          };
          syncBuiltinESMExports();
          process.argv = [process.execPath, ${JSON.stringify(script)}, "configure"];
          await import(pathToFileURL(process.argv[1]).href);
        `,
      { TESTBOX_EXPIRES_AT: "1" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("idle setting updated");
  });

  it("keeps every budgeted runner behind shared admission and pre-checkout expiry", () => {
    type Step = { name: string; run?: string };
    type Job = {
      needs?: string;
      "runs-on"?: string;
      if?: string;
      steps?: Step[];
      concurrency?: { group: string; queue: string; "cancel-in-progress": boolean };
    };
    let guarded = 0;
    const expiryPrograms = new Set<string | undefined>();
    for (const file of readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"))) {
      const jobs: Record<string, Job> = parse(
        readFileSync(`.github/workflows/${file}`, "utf8"),
      ).jobs;
      for (const job of Object.values(jobs ?? {}).filter((candidate) =>
        candidate.steps?.some((step) => step.name === "Begin Testbox"),
      )) {
        guarded++;
        expect(
          jobs.admission?.steps?.some(
            (step) => step.run === "node scripts/ci-testbox-budget.mjs admit",
          ),
        ).toBe(true);
        expect(job.needs).toBe("admission");
        expect(job["runs-on"]).toContain("needs.admission.outputs.runner");
        expect(job.if).toContain("needs.admission.result == 'success'");
        expect(job.concurrency).toMatchObject({
          group: expect.stringContaining("needs.admission.outputs.group"),
          queue: "max",
          "cancel-in-progress": false,
        });
        const steps = job.steps ?? [];
        const expiry = steps.findIndex((step) => step.name === "Reject expired Testbox admission");
        expect(expiry).toBeGreaterThan(steps.findIndex((step) => step.name === "Begin Testbox"));
        expect(expiry).toBeLessThan(steps.findIndex((step) => step.name === "Checkout"));
        expiryPrograms.add(steps[expiry]?.run);
      }
    }
    expect(guarded).toBeGreaterThan(0);
    expect(expiryPrograms.size).toBe(1);
    expect(expiryPrograms.has(undefined)).toBe(false);
  });

  it.each([59, 60])("enforces the shell queue deadline at %s minutes", (minutes) => {
    const workflow = parse(readFileSync(".github/workflows/ci-check-testbox.yml", "utf8"));
    const expiry = workflow.jobs.check.steps.find(
      (step: { name: string }) => step.name === "Reject expired Testbox admission",
    );
    const result = spawnSync(
      "bash",
      ["-c", `date() { printf '%s\\n' "$TESTBOX_NOW_SECONDS"; }\n${expiry.run}`],
      {
        encoding: "utf8",
        env: {
          TESTBOX_EXPIRES_AT: String(planAdmission().expires_at),
          TESTBOX_NOW_SECONDS: String(Date.parse(request.createdAt) / 1000 + minutes * 60),
        },
      },
    );
    expect(result.status, result.stderr).toBe(minutes < 60 ? 0 : 1);
  });
});

describe("Testbox admission GitHub response", () => {
  const secret = "synthetic-response-secret";
  const requestId = "ABCD:123456:789ABC:01234567";
  const rateHeaders = {
    "x-github-request-id": requestId,
    "x-ratelimit-limit": "1000",
    "x-ratelimit-remaining": "0",
    "x-ratelimit-used": "1000",
    "x-ratelimit-reset": "1790859600",
    "x-ratelimit-resource": "core",
    "retry-after": "60",
  };
  const denial = (body: string, classification = "forbidden", bodyKind = "json") => ({
    status: 403,
    body,
    classification,
    bodyKind,
  });
  const jsonDenial = (message: unknown, classification = "forbidden") =>
    denial(JSON.stringify({ message }), classification);

  function admit({
    status,
    body = "",
    headers = {},
    streamError = false,
  }: {
    status: number;
    body?: string;
    headers?: Record<string, string>;
    streamError?: boolean;
  }) {
    const script = resolve("scripts/ci-testbox-budget.mjs");
    const fixture = { status, body, headers, streamError, secret, now };
    const result = runModule(
      `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { pathToFileURL } from "node:url";
      const fixture = ${JSON.stringify(fixture)};
      let requests = 0;
      let output = "";
      let canceled = false;
      Date.now = () => fixture.now;
      fs.appendFileSync = (path, text) => {
        assert.equal(path, "admission-output");
        output += text;
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (url, options) => {
        assert.equal(++requests, 1);
        assert.equal(url, "https://api.github.com/repos/example/project/actions/runs/123");
        assert.equal(options.headers.Authorization, "Bearer " + fixture.secret);
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(new ReadableStream({
          start(controller) {
            if (fixture.streamError) {
              controller.error(new Error(fixture.secret));
              return;
            }
            for (let offset = 0; offset < fixture.body.length; offset += 1024) {
              controller.enqueue(new TextEncoder().encode(fixture.body.slice(offset, offset + 1024)));
            }
            // Oversized errors deliberately stay open to exercise bounded cancellation.
            if (fixture.body.length <= 8192) controller.close();
          },
          cancel() { canceled = true; },
        }), { status: fixture.status, headers: fixture.headers });
      };
      process.on("exit", () => console.log(JSON.stringify({ requests, output, canceled })));
      process.argv = [process.execPath, ${JSON.stringify(script)}, "admit"];
      await import(pathToFileURL(process.argv[1]).href);
    `,
      {
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_REPOSITORY: "example/project",
        GITHUB_RUN_ID: "123",
        GH_TOKEN: secret,
        GITHUB_OUTPUT: "admission-output",
        TESTBOX_PROFILE: "check",
        TESTBOX_ID: "tbx_example",
      },
    );
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null") as {
      requests: number;
      output: string;
      canceled: boolean;
    };
    expect(receipt.requests).toBe(1);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    return { ...result, receipt };
  }

  it.each<Parameters<typeof admit>[0] & { classification: string; bodyKind: string }>([
    { ...jsonDenial(secret, "primary-rate-limit"), headers: rateHeaders },
    jsonDenial("You have exceeded a secondary rate limit. " + secret, "secondary-rate-limit"),
    jsonDenial("Resource not accessible by integration", "resource-not-accessible"),
    jsonDenial(secret),
    denial('{"message":"' + secret, "forbidden", "invalid-json"),
    jsonDenial({ value: secret }),
    {
      ...denial(
        JSON.stringify({
          message: "You have exceeded a secondary rate limit.",
          extra: secret.repeat(1000),
        }),
        "primary-rate-limit",
        "too-large",
      ),
      headers: rateHeaders,
    },
    {
      status: 403,
      streamError: true,
      headers: rateHeaders,
      classification: "primary-rate-limit",
      bodyKind: "unreadable",
    },
    { status: 401, classification: "authentication-failed", bodyKind: "empty" },
    { status: 404, classification: "not-found", bodyKind: "empty" },
    { status: 429, classification: "rate-limited", bodyKind: "empty" },
    { status: 503, classification: "service-error", bodyKind: "empty" },
  ])("denies $status/$classification/$bodyKind without disclosing response data", (fixture) => {
    const result = admit(fixture);
    expect(result.status).toBe(1);
    expect(result.receipt.output).toBe("");
    expect(result.stderr).toContain(`GitHub returned ${fixture.status}`);
    expect(result.stderr).toContain(`class=${fixture.classification}; body=${fixture.bodyKind}`);
    if (fixture.headers) {
      expect(result.stderr).toContain(`request_id=${requestId}`);
      for (const [key, value] of Object.entries(rateHeaders).filter(
        ([header]) => header !== "x-github-request-id",
      )) {
        expect(result.stderr).toContain(`${key}=${value}`);
      }
    }
    if (fixture.bodyKind === "too-large") {
      expect(result.receipt.canceled).toBe(true);
    }
  });

  it("omits malformed or unrecognized header values instead of printing them", () => {
    const headers = Object.fromEntries(Object.keys(rateHeaders).map((name) => [name, secret]));
    const result = admit({ status: 403, headers });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("class=forbidden");
    expect(result.stderr).not.toContain("request_id=");
    expect(result.stderr).not.toContain("; x-ratelimit-");
    expect(result.stderr).not.toContain("retry-after=");
  });

  it("preserves successful admission and refuses an expired dispatch", () => {
    const success = admit({ status: 200, body: JSON.stringify({ created_at: request.createdAt }) });
    expect(success.status, success.stderr).toBe(0);
    expect(success.receipt.output).toMatch(/^group=openclaw-testbox-budget-v1-\d+\n/);
    expect(success.receipt.output).toContain("minutes=60\n");
    expect(success.receipt.output).toContain(
      `expires_at=${Date.parse(request.createdAt) + 60 * 60_000}\n`,
    );
    const expired = admit({
      status: 200,
      body: JSON.stringify({ created_at: "2026-10-01T11:00:00Z" }),
    });
    expect(expired.status).toBe(1);
    expect(expired.receipt.output).toBe("");
    expect(expired.stderr).toContain("admission expired");
  });
});
