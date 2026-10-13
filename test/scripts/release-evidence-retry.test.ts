import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const transport = vi.hoisted(() => ({ read: vi.fn(), sleep: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync: (...args: unknown[]) => transport.read(...args),
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (...args: unknown[]) => ({
        stdout: transport.read(...args),
        stderr: "",
      }),
    }),
  };
});
vi.mock("node:timers/promises", () => ({ setTimeout: transport.sleep }));

import { createReleaseEvidenceClient, runReleaseCiGh } from "../../scripts/release-ci-summary.mjs";

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
    { mode: "async", failures: 1, network: false },
    { mode: "sync", failures: 4, network: false },
    { mode: "async", failures: 4, network: false },
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
