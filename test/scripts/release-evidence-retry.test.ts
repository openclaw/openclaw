import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const transport = vi.hoisted(() => ({ read: vi.fn(), sleep: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync: (...args: unknown[]) => transport.read(...args),
  };
});
vi.mock("../../scripts/lib/plain-gh.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/plain-gh.mjs")>()),
  execGhReadAsync: async (...args: unknown[]) => transport.read("gh", ...args),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: transport.sleep }));

import {
  createReleaseEvidenceClient,
  runReleaseCiGh,
  validateReleaseRunEvidence,
} from "../../scripts/release-ci-summary.mjs";
import { trustedMainNpmFixture } from "./release-ci-summary.test-support.js";

function readPluginArtifactMetadata() {
  const workflow = parse(readFileSync(".github/workflows/plugin-npm-release.yml", "utf8"));
  const step = workflow.jobs.verify_plugin_npm_preflight.steps.find(
    (entry: { name: string }) => entry.name === "Validate npm preflight artifact readback",
  );
  const script = step.run.match(/node --input-type=module <<'NODE'[^\n]*\n([\s\S]*?)\nNODE/u)?.[1];
  if (!script) {
    throw new Error("Plugin artifact readback must use the release evidence read boundary");
  }
  let output = "";
  runInNewContext(script.replace(/^import .*;\n/mu, ""), {
    runReleaseCiGh,
    URLSearchParams,
    process: {
      env: {
        ARTIFACT_NAME: "plugin-npm-package-source-fixture-demo+encoded",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        RUN_ID: "42",
      },
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    },
  });
  return JSON.parse(output);
}

afterEach(() => {
  vi.restoreAllMocks();
  transport.read.mockReset();
  transport.sleep.mockReset();
});

describe("release evidence API reads", () => {
  it("reads only the named plugin artifact after a transient metadata failure", () => {
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    transport.read.mockImplementationOnce(() => {
      throw Object.assign(new Error("gh failed"), { stderr: "gh: Server Error (HTTP 504)" });
    });
    const metadata = {
      total_count: 1,
      artifacts: [
        { id: 7, name: "plugin-npm-package-source-fixture-demo+encoded", expired: false },
      ],
    };
    transport.read.mockReturnValue(JSON.stringify(metadata));
    expect(readPluginArtifactMetadata()).toEqual(metadata);
    expect(transport.read.mock.calls.map((call) => call[1])).toEqual([
      [
        "api",
        "repos/openclaw/openclaw/actions/runs/42/artifacts?name=plugin-npm-package-source-fixture-demo%2Bencoded&per_page=100",
      ],
      [
        "api",
        "repos/openclaw/openclaw/actions/runs/42/artifacts?name=plugin-npm-package-source-fixture-demo%2Bencoded&per_page=100",
      ],
    ]);
  });

  it.each([
    { total_count: 101, artifacts: [{ id: 7 }] },
    { artifacts: [{ id: 7 }] },
    { total_count: 1, artifacts: null },
  ])("rejects incomplete plugin artifact enumeration without retrying: %j", (response) => {
    transport.read.mockReturnValue(JSON.stringify(response));
    expect(readPluginArtifactMetadata).toThrow(
      "Package artifact enumeration is incomplete or invalid",
    );
    expect(transport.read).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "sync", failures: 1, network: false },
    // Job-listing 5xx responses fall back to smaller pages instead (covered below).
    { mode: "async", failures: 1, network: true },
    { mode: "sync", failures: 4, network: false },
    { mode: "async", failures: 4, network: true },
    { mode: "sync", failures: 1, network: true },
  ])(
    "bounds $mode retries ($failures failures, network: $network)",
    async ({ mode, failures, network }) => {
      const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      const failure = Object.assign(
        new Error("gh failed"),
        network
          ? { code: "ECONNRESET" }
          : {
              stderr: "gh: Server Error (HTTP 502)",
              stdout: "partial response",
            },
      );
      for (let attempt = 0; attempt < failures; attempt++) {
        transport.read.mockImplementationOnce(() => {
          throw failure;
        });
      }
      transport.read.mockReturnValue(
        mode === "sync" ? '{"id":42}' : '{"total_count":1,"jobs":[{"id":7}]}',
      );
      const client = createReleaseEvidenceClient("openclaw/openclaw");
      const result = Promise.resolve().then(() =>
        mode === "sync" ? client.getRunAttempt("42", 1) : client.getRunAttemptJobs("42", 1),
      );
      if (failures === 4) {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toEqual(mode === "sync" ? { id: 42 } : [{ id: 7 }]);
      }
      expect(transport.read).toHaveBeenCalledTimes(failures === 4 ? 4 : 2);
      expect(
        mode === "sync"
          ? wait.mock.calls.map((call) => call[3])
          : transport.sleep.mock.calls.map((call) => call[0]),
      ).toEqual(failures === 4 ? [2000, 4000, 8000] : [2000]);
    },
  );

  it("recovers strict child verification when GitHub 5xxs 100-job attempt pages", async () => {
    const fixture = trustedMainNpmFixture("stable");
    const fixtureJobs = fixture.client.getRunAttemptJobs;
    transport.read.mockImplementation((_bin: string, args: string[]) => {
      const match =
        /^repos\/openclaw\/openclaw\/actions\/runs\/(\d+)\/attempts\/\d+\/jobs\?page=1&per_page=(\d+)$/u.exec(
          args[1] ?? "",
        );
      if (args[0] !== "api" || args.length !== 2 || !match) {
        throw new Error(`unplanned evidence read: ${args.join(" ")}`);
      }
      if (match[2] === "100") {
        throw Object.assign(new Error("gh failed"), { stderr: "gh: Server Error (HTTP 502)" });
      }
      const jobs = fixtureJobs(match[1]!);
      return JSON.stringify({ total_count: jobs.length, jobs });
    });
    const evidenceClient = createReleaseEvidenceClient("openclaw/openclaw");
    const evidence = await validateReleaseRunEvidence(
      {
        runId: fixture.runId,
        verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
        verifierSourceSha: "c".repeat(40),
      },
      {
        ...fixture.client,
        getRunAttemptJobs: (runId: string, runAttempt: number) =>
          evidenceClient.getRunAttemptJobs(runId, runAttempt),
      },
    );
    expect(evidence.children).toHaveLength(6);
    const pageSizes = transport.read.mock.calls.map((call) => call[1][1].split("per_page=")[1]);
    // Children are read concurrently; each one reads 100 (502) then 50 exactly once.
    expect(pageSizes.filter((size) => size === "100")).toHaveLength(6);
    expect(pageSizes.filter((size) => size === "50")).toHaveLength(6);
    expect(pageSizes).toHaveLength(12);
    expect(transport.sleep).not.toHaveBeenCalled();
  });

  it.each([
    { total: 1000, requireComplete: true, result: 1000 },
    { total: 1001, requireComplete: true, result: "incomplete or duplicated" },
    { total: 1001, requireComplete: false, result: 1000 },
  ])(
    "keeps the 1,000-job ceiling after falling back to 30-job pages: $total jobs, complete $requireComplete",
    async ({ total, requireComplete, result }) => {
      const jobs = Array.from({ length: total }, (_, index) => ({ id: index + 1 }));
      transport.read.mockImplementation((_bin: string, args: string[]) => {
        const query = new URLSearchParams((args[1] ?? "").split("?")[1]);
        const perPage = Number(query.get("per_page"));
        if (perPage > 30) {
          throw Object.assign(new Error("gh failed"), { stderr: "gh: Server Error (HTTP 502)" });
        }
        const start = (Number(query.get("page")) - 1) * perPage;
        return JSON.stringify({ total_count: total, jobs: jobs.slice(start, start + perPage) });
      });
      const read = createReleaseEvidenceClient("openclaw/openclaw").getRunAttemptJobs("42", 2, {
        requireComplete,
      });
      if (typeof result === "number") {
        await expect(read).resolves.toEqual(jobs.slice(0, result));
      } else {
        await expect(read).rejects.toThrow(result);
      }
      // 100 and 50 each fail once; 30-job pages stop once 1,000 jobs are held (34 pages).
      expect(transport.read).toHaveBeenCalledTimes(2 + 34);
      expect(transport.sleep).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "POST",
      ["api", "repos/openclaw/openclaw/actions/runs/42/rerun", "--method", "POST"],
      "HTTP 502",
    ],
    ["implicit POST", ["api", "repos/openclaw/openclaw/issues", "-f", "title=test"], "HTTP 502"],
    ["GraphQL", ["api", "graphql"], "HTTP 502"],
    ["forbidden", ["api", "repos/openclaw/openclaw/actions/runs/42"], "HTTP 403"],
    ["rate limited", ["api", "repos/openclaw/openclaw/actions/runs/42"], "HTTP 429"],
  ])("does not retry %s", (_label, args, stderr) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(new Error("gh failed"), { stderr });
    transport.read.mockImplementation(() => {
      throw failure;
    });
    expect(() => runReleaseCiGh(args)).toThrow(failure);
    expect(transport.read).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry a malformed successful response", () => {
    transport.read.mockReturnValue("invalid JSON");
    expect(() => createReleaseEvidenceClient("openclaw/openclaw").getRunAttempt("42", 1)).toThrow();
    expect(transport.read).toHaveBeenCalledOnce();
  });
});
