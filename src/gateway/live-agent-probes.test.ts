import { afterEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());
// mock-isolation: Child execution is the external I/O boundary; this fixture must not spawn a CLI.
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

import {
  assertCronJobMatches,
  assertLiveImageProbeReply,
  buildLiveCronProbeMessage,
  createLiveCronProbeSpec,
  resolveOpenClawCliProcessArgs,
  runOpenClawCliJson,
  shouldRunLiveImageProbe,
} from "./live-agent-probes.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live-agent-probes", () => {
  it("runs CLI probes through standalone identity without a loose entry", async () => {
    vi.stubGlobal("__openclawStandaloneRootUrl", "file:///standalone/runtime/");
    runExecMock.mockResolvedValueOnce({ stdout: '{"ok":true}', stderr: "" });

    await expect(runOpenClawCliJson(["cron", "list"], {})).resolves.toEqual({ ok: true });
    expect(runExecMock).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      ["cron", "list", "--timeout", "30000"],
      expect.objectContaining({ cwd: process.cwd(), baseEnv: {} }),
    );
  });

  it.each([
    [false, "scripts/run-node.mjs"],
    [true, "openclaw.mjs"],
  ] as const)("selects CLI entry for built=%s", (built, entry) => {
    expect(resolveOpenClawCliProcessArgs(["cron", "list"], built)).toEqual([entry, "cron", "list"]);
  });

  it("accepts only cat for the shared image probe reply", () => {
    expect(assertLiveImageProbeReply("cat")).toBeUndefined();
    expect(assertLiveImageProbeReply("metadata unavailable.cat")).toBeUndefined();
    expect(() => assertLiveImageProbeReply("horse")).toThrow("image check expected 'cat'");
    expect(() => assertLiveImageProbeReply("caterpillar")).toThrow("image check expected 'cat'");
  });

  it("skips the shared image probe for text-only live agents unless forced", () => {
    expect(shouldRunLiveImageProbe({ agent: "claude" })).toBe(true);
    expect(shouldRunLiveImageProbe({ agent: "opencode" })).toBe(false);
    expect(shouldRunLiveImageProbe({ agent: "opencode", override: "1" })).toBe(true);
    expect(shouldRunLiveImageProbe({ agent: "claude", override: "0" })).toBe(false);
  });

  it("builds a retryable cron prompt with provider-specific fallback wording", () => {
    const spec = createLiveCronProbeSpec({
      agentId: "codex",
      sessionKey: "agent:codex:acp:test",
      model: "openai/gpt-5.6-luna@openai:manual",
    });
    const retryPrompt = (agent: string) =>
      buildLiveCronProbeMessage({
        agent,
        argsJson: spec.argsJson,
        attempt: 1,
        exactReply: spec.name,
      });
    const claudeRetryPrompt = retryPrompt("claude-cli");
    expect(claudeRetryPrompt).toContain(
      "Preserve job.sessionTarget and job.sessionKey exactly as provided.",
    );
    expect(claudeRetryPrompt).toContain(
      "search/load MCP tools for `openclaw automations` or `automations`",
    );
    expect(claudeRetryPrompt).toContain("mcp__openclaw__automations");
    expect(claudeRetryPrompt).toContain("Do not use Claude native `CronCreate`");
    expect(claudeRetryPrompt).not.toContain("openclaw-tools");
    expect(retryPrompt("future-agent")).toContain("ask me to retry");
    expect(retryPrompt("codex")).toContain(
      "previous OpenClaw automations MCP tool call was cancelled",
    );
    const args: { job?: unknown } = JSON.parse(spec.argsJson);
    expect(args.job).toEqual(
      expect.objectContaining({
        sessionTarget: "session:agent:codex:acp:test",
        agentId: "codex",
        sessionKey: "agent:codex:acp:test",
        delivery: { mode: "none" },
        payload: expect.objectContaining({ model: "openai/gpt-5.6-luna@openai:manual" }),
      }),
    );
  });

  it("builds a cron probe spec when the process clock is outside the Date range", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    try {
      const spec = createLiveCronProbeSpec();
      const args: { job?: { schedule?: { at?: string } } } = JSON.parse(spec.argsJson);
      expect(spec.at).toBe("1970-01-01T00:00:00.000Z");
      expect(args.job?.schedule?.at).toBe("1970-01-01T00:00:00.000Z");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it.each([undefined, "current"])("validates cron cli job shape with target %s", (target) => {
    expect(
      assertCronJobMatches({
        job: {
          name: "live-mcp-abc",
          sessionTarget: target ?? "session:agent:dev:test",
          agentId: "dev",
          sessionKey: "agent:dev:test",
          payload: { kind: "agentTurn", message: "probe-abc" },
        },
        expectedName: "live-mcp-abc",
        expectedMessage: "probe-abc",
        expectedSessionKey: "agent:dev:test",
        expectedSessionTarget: target,
      }),
    ).toBeUndefined();
  });
});
