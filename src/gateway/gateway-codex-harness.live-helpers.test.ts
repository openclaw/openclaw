import { describe, expect, it } from "vitest";
import {
  requireSuccessfulNativeCommandCompactionEvidence,
  requireSuccessfulPersistedNativeCommandExecution,
} from "./gateway-codex-harness.command-evidence.live-helpers.js";
import {
  buildCodexHarnessLargeOutputCommand,
  CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES,
  isExpectedCodexModelsCommandText,
  isExpectedCodexStatusCommandText,
  isExpectedYieldedAgentTimeout,
  isRetryableCodexHarnessLiveError,
  isStrictExpectedCodexModelsCommandText,
  requireSuccessfulNativeCommandExecution,
  shouldUseCodexHarnessSubagentOnlyFastPath,
} from "./gateway-codex-harness.live-helpers.js";

const commandMarker = "OPENCLAW-COMMAND";
const expectedCommand = `node -e 'console.log("${commandMarker}")'`;
const commandParams = { commandMarker, expectedCommand, minimumOutputChars: 1_000 };
const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function commandStart(itemId: string | undefined, command = expectedCommand) {
  return { stream: "tool", data: { phase: "start", name: "bash", itemId, args: { command } } };
}

function commandResult(
  itemId: string,
  result: Record<string, unknown> = { exitCode: 0 },
  isError = false,
) {
  return {
    stream: "tool",
    data: { phase: "result", itemId, status: "completed", isError, result },
  };
}

function completedCommandEvents(itemId = "call") {
  return [commandStart(itemId), commandResult(itemId)];
}

function persistedCall(command = expectedCommand) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command } }],
  };
}

function persistedResult(toolCallId = "call", isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    isError,
    content: [
      { type: "text", text: commandMarker },
      { type: "text", text: "...(truncated: original 2000 chars)" },
    ],
  };
}

describe("gateway codex harness live helpers", () => {
  it("builds an exact large-output command without escape-sensitive newlines", () => {
    const command = buildCodexHarnessLargeOutputCommand({
      commandMarker,
      outputBytes: CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES,
    });
    expect(command).toContain(`"${commandMarker}|"`);
    expect(command).toContain(".slice(0,800000)");
    expect(CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES).toBeLessThan(1024 * 1024);
    expect(command).not.toContain("\\n");
    expect(command).not.toContain("\n");
  });

  it("keeps combined stress probes out of the subagent-only fast path", () => {
    const base = {
      chatImageProbe: false,
      codeModeOnly: false,
      compactionStress: false,
      explicitOptOut: false,
      guardianProbe: false,
      imageProbe: false,
      mcpProbe: false,
      multiSessionProbe: false,
      resumeStress: false,
      subagentProbe: true,
    };
    expect(shouldUseCodexHarnessSubagentOnlyFastPath(base)).toBe(true);
    for (const flag of [
      "codeModeOnly",
      "compactionStress",
      "explicitOptOut",
      "multiSessionProbe",
      "resumeStress",
    ] as const) {
      expect(shouldUseCodexHarnessSubagentOnlyFastPath({ ...base, [flag]: true })).toBe(false);
    }
  });

  it("retries sessions.list timeouts but not unrelated live errors", () => {
    expect(
      isRetryableCodexHarnessLiveError(new Error("gateway request timeout for sessions.list")),
    ).toBe(true);
    expect(
      isRetryableCodexHarnessLiveError(new Error("subagent child did not emit lifecycle event")),
    ).toBe(false);
  });

  it("accepts a successful wrapped command retry after an earlier matching failure", () => {
    const wrappedCommand = `node -e "console.log(\\"${commandMarker}\\")"`;
    const events = [
      commandStart("echo", `echo ${shellSingleQuote(expectedCommand)}`),
      commandResult("echo"),
      commandStart("first"),
      commandResult("first", { exitCode: 1 }, true),
      commandStart("retry", `/bin/bash -lc ${shellSingleQuote(wrappedCommand)}`),
      commandResult("retry"),
    ];
    expect(requireSuccessfulNativeCommandExecution(events, commandParams)).toEqual({
      itemId: "retry",
      resultIndex: 5,
      startIndex: 4,
    });
  });

  it("accepts completed commands with omitted or null exit codes", () => {
    for (const result of [{ status: "completed" }, { status: "completed", exitCode: null }]) {
      expect(
        requireSuccessfulNativeCommandExecution(
          [commandStart("call"), commandResult("call", result)],
          commandParams,
        ),
      ).toEqual({ itemId: "call", resultIndex: 1, startIndex: 0 });
    }
  });

  it("reports a missing native command item id", () => {
    expect(() =>
      requireSuccessfulNativeCommandExecution([commandStart(undefined)], commandParams),
    ).toThrow(`native bash command start for marker ${commandMarker} has no itemId`);
  });

  it("bounds failed-command diagnostics to the matching item without raw output", () => {
    const secretOutput = "sensitive-command-output";
    let message = "";
    try {
      requireSuccessfulNativeCommandExecution(
        [
          commandStart("failed"),
          commandResult("other", { stderr: secretOutput, exitCode: 1 }, true),
          commandResult("failed", { stdout: secretOutput, exitCode: 1 }, true),
        ],
        commandParams,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("has no successful result");
    expect(message).toContain('"itemId":"failed"');
    expect(message).toContain(`"stdoutChars":${secretOutput.length}`);
    expect(message).not.toContain("other");
    expect(message).not.toContain(secretOutput);
  });

  it("requires a matching call or explicit call id for a durable large result", () => {
    const result = persistedResult();
    expect(
      requireSuccessfulPersistedNativeCommandExecution([persistedCall(), result], commandParams),
    ).toEqual({ callIndex: 0, resultIndex: 1, toolCallId: "call" });
    expect(() => requireSuccessfulPersistedNativeCommandExecution([result], commandParams)).toThrow(
      "has no successful large result",
    );
    expect(
      requireSuccessfulPersistedNativeCommandExecution([result], {
        ...commandParams,
        toolCallId: "call",
      }),
    ).toEqual({ callIndex: -1, resultIndex: 0, toolCallId: "call" });
  });

  it("rejects echoed or failed native commands in durable history", () => {
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(
        [persistedCall(`echo ${shellSingleQuote(expectedCommand)}`), persistedResult()],
        commandParams,
      ),
    ).toThrow("has no successful large result");
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(
        [persistedCall(), persistedResult("call", true)],
        commandParams,
      ),
    ).toThrow("has no successful large result");
    expect(() =>
      requireSuccessfulPersistedNativeCommandExecution(
        [persistedCall(), { ...persistedResult(), details: { status: "completed", exitCode: 17 } }],
        commandParams,
      ),
    ).toThrow("has no successful large result");
  });

  it("accepts request-local evidence only when later compaction removed the durable result", () => {
    const events = [
      ...completedCommandEvents(),
      { stream: "compaction", data: { phase: "end", completed: true } },
    ];
    const params = { ...commandParams, events, messages: [] };
    expect(requireSuccessfulNativeCommandCompactionEvidence(params)).toEqual({
      source: "compacted-event",
    });
    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({ ...params, events: events.slice(0, 2) }),
    ).toThrow("successful request-local command result was not followed by compaction");
    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        ...params,
        messages: [persistedResult("call", true)],
      }),
    ).toThrow("durable result for successful request-local command failed validation");
  });

  it("rejects durable output without successful request-local evidence", () => {
    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        ...commandParams,
        events: [],
        messages: [persistedCall(`echo ${shellSingleQuote(expectedCommand)}`), persistedResult()],
      }),
    ).toThrow("has no successful request-local evidence");
  });

  it("ties a result-only durable row to the exact request-local item id", () => {
    const params = { ...commandParams, events: completedCommandEvents() };
    expect(
      requireSuccessfulNativeCommandCompactionEvidence({
        ...params,
        messages: [persistedResult("different"), persistedResult()],
      }),
    ).toEqual({ source: "persisted-history" });
    expect(() =>
      requireSuccessfulNativeCommandCompactionEvidence({
        ...params,
        messages: [persistedResult("different")],
      }),
    ).toThrow("successful request-local command result was not followed by compaction");
  });

  it("accepts only paused yielded agent timeouts for native subagent delivery", () => {
    expect(
      isExpectedYieldedAgentTimeout({
        status: "timeout",
        result: { meta: { livenessState: "paused", yielded: true } },
      }),
    ).toBe(true);
    expect(
      isExpectedYieldedAgentTimeout({
        status: "timeout",
        result: { meta: { livenessState: "paused", yielded: false } },
      }),
    ).toBe(false);
    expect(
      isExpectedYieldedAgentTimeout({
        status: "ok",
        result: { meta: { livenessState: "paused", yielded: true } },
      }),
    ).toBe(false);
  });

  it("requires the harness session for OpenClaw status prose", () => {
    const text =
      "OpenClaw is running on `openai/gpt-5.5`. Context is at `22k/272k`, no compactions, and the current session is `agent:dev:live-codex-harness`.";
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
    expect(isExpectedCodexStatusCommandText(text.replace("live-codex-harness", "other"))).toBe(
      false,
    );
  });

  it.each([
    "Session status: running on `openai/gpt-5.5`, context at 24k/272k (9%), no compactions.",
    "Session is running on `codex/gpt-5.5`. Context is about 9% used. Cache hit is `99%`; no compactions so far.",
    "Current session status:\n- Model: `openai/gpt-5.5`\n- Runtime: `OpenAI Codex`",
    "Working normally. Current workspace: `/tmp/openclaw-live-codex-harness/workspace/dev`.",
    "Idle and ready.",
    "Ready.",
    "I'm online in `/tmp/openclaw-live-codex-harness/workspace/dev`. No active task is running right now.",
  ])("accepts status shape: %s", (text) => {
    expect(isExpectedCodexStatusCommandText(text)).toBe(true);
  });

  it("requires actual model evidence for a strict model list", () => {
    expect(isStrictExpectedCodexModelsCommandText("Available models:\n- `gpt-5.4`")).toBe(true);
    expect(isStrictExpectedCodexModelsCommandText("Available models:")).toBe(false);
  });

  it.each([
    "`/codex models` opened an interactive model-selection prompt. Visible options in this session:\n- `GPT-5.4`\nCurrent active model is `codex/gpt-5.4`.",
    "Configured models in this session:\n- `codex/gpt-5.4`\nCurrent session model is `codex/gpt-5.4`.",
    "Available Codex agent models:\n- `dev`: `openai/gpt-5.5`\nRuntime: `codex`",
  ])("accepts usable model evidence: %s", (text) => {
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
    expect(isStrictExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("rejects command-unavailable prose for strict live codex models proof", () => {
    const texts = [
      "`codex` is not installed on the shell PATH in this environment, so `/codex models` could not be executed. /bin/bash: codex: command not found",
      "I couldn’t list them because `codex models` requires running outside the sandbox here, and that approval was rejected.",
      "`codex models` didn’t return a plain list in this environment; it dropped into the interactive TUI instead. Current selected model: `local-default-model`",
    ];
    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
    }
  });

  it("accepts sandbox escalation rejection for codex models", () => {
    const texts = [
      "I couldn’t list them because `codex models` requires running outside the sandbox here, and that approval was rejected.",
      "I couldn’t list them because the local `codex models` command requires elevated execution in this environment, and that request was rejected.",
      "I couldn’t list them because the local `codex models` command requires host permissions here, and that escalation was rejected.",
      "I couldn’t run `codex models` because the sandboxed attempt failed and the required elevated retry was not approved.",
      "I tried `codex models`, but the sandbox blocked it due to the kernel namespace restriction. I then requested an escalated run, but the automatic approval review failed before it could be approved.",
    ];
    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
      expect(isStrictExpectedCodexModelsCommandText(text)).toBe(false);
    }
  });
});
