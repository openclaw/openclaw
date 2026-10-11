import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.restoreAllMocks();
  transport.read.mockReset();
  transport.sleep.mockReset();
});

describe("release evidence API reads", () => {
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
