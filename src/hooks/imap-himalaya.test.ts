import { describe, expect, it, vi } from "vitest";
import { listEnvelopes } from "./imap-himalaya.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
  }),
}));

const runCommandWithTimeout = vi.fn();
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (args: string[]) => runCommandWithTimeout(args),
}));

describe("imap-himalaya", () => {
  it("preserves quoted query terms as a single argument", async () => {
    runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "[]", stderr: "" });

    const query = 'subject "Build Failed"';
    await listEnvelopes({
      account: "main",
      folder: "INBOX",
      query,
      pageSize: 25,
    });

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const [args] = runCommandWithTimeout.mock.calls[0] as [string[]];
    expect(args).toContain(query);
    expect(args.filter((arg) => arg === query)).toHaveLength(1);
  });

  it("skips empty queries", async () => {
    runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "[]", stderr: "" });

    await listEnvelopes({
      account: "main",
      folder: "INBOX",
      query: "   ",
      pageSize: 25,
    });

    const [args] = runCommandWithTimeout.mock.calls[0] as [string[]];
    expect(args).not.toContain("");
    expect(args).not.toContain("   ");
  });
});
