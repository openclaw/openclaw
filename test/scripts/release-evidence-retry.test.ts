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
  it("reads attempt jobs with smaller pages when GitHub 5xxs 100-job pages", async () => {
    const jobs = Array.from({ length: 128 }, (_, index) => ({
      id: index + 1,
      name: `job ${index}`,
    }));
    transport.read.mockImplementation((_bin: string, args: string[]) => {
      const match =
        /^repos\/openclaw\/openclaw\/actions\/runs\/123\/attempts\/2\/jobs\?page=(\d+)&per_page=(\d+)$/u.exec(
          args[1] ?? "",
        );
      if (args[0] !== "api" || !match) {
        throw new Error(`unplanned evidence read: ${args.join(" ")}`);
      }
      const [page, perPage] = [Number(match[1]), Number(match[2])];
      if (perPage === 100) {
        throw Object.assign(new Error("gh failed"), { stderr: "gh: Server Error (HTTP 502)" });
      }
      return JSON.stringify({
        total_count: jobs.length,
        jobs: jobs.slice((page - 1) * perPage, page * perPage),
      });
    });

    const listed = await createReleaseEvidenceClient("openclaw/openclaw").getRunAttemptJobs(
      "123",
      2,
    );

    expect(listed.map((job: { id: number }) => job.id)).toEqual(jobs.map((job) => job.id));
    const pageSizes = transport.read.mock.calls.map((call) => call[1][1].split("per_page=")[1]);
    expect(pageSizes).toEqual(["100", "50", "50", "50"]);
    expect(transport.sleep).not.toHaveBeenCalled();
  });

  it.each(["sync", "async"])("recovers a 502 followed by 200 (%s)", async (mode) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(new Error("gh failed"), {
      stderr: "gh: Server Error (HTTP 502)",
      stdout: "partial response",
    });
    transport.read.mockImplementationOnce(() => {
      throw failure;
    });
    transport.read.mockReturnValue(
      mode === "sync" ? '{"id":42}' : '{"total_count":1,"jobs":[{"id":7}]}',
    );
    const client = createReleaseEvidenceClient("openclaw/openclaw");
    const result =
      mode === "sync" ? client.getRunAttempt("42", 1) : await client.getRunAttemptJobs("42", 1);
    expect(result).toEqual(mode === "sync" ? { id: 42 } : [{ id: 7 }]);
    expect(transport.read).toHaveBeenCalledTimes(2);
    // Job listings answer a 5xx with the next smaller page size instead of sleeping.
    expect(
      mode === "sync"
        ? wait.mock.calls.map((call) => call[3])
        : transport.sleep.mock.calls.map((call) => call[0]),
    ).toEqual(mode === "sync" ? [2000] : []);
  });

  it.each(["sync", "async"])("fails after four 502 responses (%s)", async (mode) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(new Error("gh failed"), {
      stderr: "gh: Server Error (HTTP 502)",
    });
    transport.read.mockImplementation(() => {
      throw failure;
    });
    const client = createReleaseEvidenceClient("openclaw/openclaw");
    await expect(
      Promise.resolve().then(() =>
        mode === "sync" ? client.getRunAttempt("42", 1) : client.getRunAttemptJobs("42", 1),
      ),
    ).rejects.toBe(failure);
    // Job listings try 100- and 50-job pages once, then spend the full budget on 30.
    expect(transport.read).toHaveBeenCalledTimes(mode === "sync" ? 4 : 6);
    expect(
      mode === "sync"
        ? wait.mock.calls.map((call) => call[3])
        : transport.sleep.mock.calls.map((call) => call[0]),
    ).toEqual([2000, 4000, 8000]);
  });

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
    ["not found", ["api", "repos/openclaw/openclaw/actions/runs/42"], "HTTP 404"],
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

  it.each(["ECONNRESET", "ETIMEDOUT", "unexpected EOF"])("recovers a network error: %s", (code) => {
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    transport.read.mockImplementationOnce(() => {
      throw Object.assign(new Error(code), { code });
    });
    transport.read.mockReturnValue('{"id":42}');
    expect(createReleaseEvidenceClient("openclaw/openclaw").getRunAttempt("42", 1)).toEqual({
      id: 42,
    });
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it("does not retry a malformed successful response", () => {
    transport.read.mockReturnValue("invalid JSON");
    expect(() => createReleaseEvidenceClient("openclaw/openclaw").getRunAttempt("42", 1)).toThrow();
    expect(transport.read).toHaveBeenCalledOnce();
  });
});
