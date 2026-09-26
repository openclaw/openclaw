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
    expect(
      mode === "sync"
        ? wait.mock.calls.map((call) => call[3])
        : transport.sleep.mock.calls.map((call) => call[0]),
    ).toEqual([2000]);
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
    expect(transport.read).toHaveBeenCalledTimes(4);
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
