// Exercises the fake-backend TUI PTY harness and visible terminal output.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exerciseTuiCommandSurface } from "./tui-pty-command-surfaces-test-support.js";
import {
  approveWorkspaceSkill,
  COMPACT_TERMINAL_SIZES,
  disposeActiveTuiFixtures,
  exerciseFragmentedUnicodePrompt,
  exerciseNarrowTerminalRendering,
  exerciseTerminalOutputSafety,
  objectFieldEquals,
  readFixtureLog,
  selectTuiFixtureSession,
  startTuiFixture,
  waitForSynchronizedFrameRows,
  type FixtureLogEntry,
} from "./tui-pty-harness-fixture-test-support.js";
import {
  registerTuiDisconnectedDraftTests,
  registerTuiReconnectTests,
} from "./tui-pty-reconnect-test-support.js";
import {
  exerciseStreamingRendering,
  registerToolCardRenderingTests,
  streamingPrefixFrame,
  toolFrame,
} from "./tui-pty-rendering-test-support.js";
import { exerciseStartupHistoryRendering } from "./tui-pty-startup-session-fixture-test-support.js";
const STARTUP_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 5_000;
const STARTUP_TEST_TIMEOUT_MS = 25_000;

const fixtureEntry =
  (method: string, fields: Record<string, unknown> = {}) =>
  (entry: FixtureLogEntry) =>
    entry.method === method &&
    Object.entries(fields).every(([key, value]) => objectFieldEquals(entry, key, value));

async function startHarness(options: Parameters<typeof startTuiFixture>[0] = {}) {
  const fixture = await startTuiFixture(options);
  const records = () => readFixtureLog(fixture.logPath);
  return {
    ...fixture,
    records,
    write: fixture.run.write,
    wait: fixture.run.waitForOutput,
    output: fixture.run.visibleOutput,
    call: (signal: AbortSignal, method: string, fields: Record<string, unknown> = {}) =>
      fixture.waitForLogEntry(fixtureEntry(method, fields), signal),
    hasCall: async (method: string, fields: Record<string, unknown> = {}) =>
      (await records()).some(fixtureEntry(method, fields)),
  };
}

async function withFixture(
  env: NodeJS.ProcessEnv | undefined,
  exercise: (fixture: Awaited<ReturnType<typeof startHarness>>) => Promise<void>,
) {
  const fixture = await startHarness({ env });
  try {
    await exercise(fixture);
  } finally {
    await fixture.cleanup();
  }
}

const countFixtureCalls = (entries: FixtureLogEntry[], method: string) =>
  entries.filter((entry) => entry.method === method).length;

const countFixtureMessages = (entries: FixtureLogEntry[], message: string) =>
  entries.filter(fixtureEntry("sendChat", { message })).length;

it("rejects rendering oracle false positives", () => {
  const tokens = Array.from({ length: 64 }, (_, i) => `T${String(i).padStart(3, "0")}`);
  const promptFrame = [`burst streaming proof ${tokens.join(" ")}`, "local ready | idle"];
  const reversedTool = ["PTY_BEFORE_TOOL PTY_TOOL_PARTIAL Read File (running)"];
  expect(streamingPrefixFrame(promptFrame)).toBe(false);
  expect(toolFrame(reversedTool, false)).toBe(false);
});

registerTuiDisconnectedDraftTests(STARTUP_TIMEOUT_MS, STARTUP_TEST_TIMEOUT_MS);

describe("TUI PTY harness", { concurrent: false }, () => {
  let fixture: Awaited<ReturnType<typeof startHarness>>;
  let compactFooter: Awaited<ReturnType<typeof startHarness>>;
  let thinkingOverride: Awaited<ReturnType<typeof startHarness>>;
  let slowStartup: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => {
    // Retain successful boots for cleanup even if a sibling boot fails.
    const boots = await Promise.allSettled([
      startHarness(),
      startHarness({
        env: {
          OPENCLAW_TUI_PTY_MODEL: "gpt-5.6-sol@openai:setup-64cddea3-938c-431e-be3b-aa47090577c7",
          OPENCLAW_TUI_PTY_THINKING_LEVEL: "high",
        },
      }),
      startHarness({
        env: {
          OPENCLAW_TUI_PTY_MODEL: "fixture-provider/fixture-model",
          OPENCLAW_TUI_PTY_THINKING_LEVEL: "medium",
          OPENCLAW_TUI_PTY_LAUNCH_THINKING: "high",
          OPENCLAW_TUI_PTY_INITIAL_MESSAGE: "thinking override proof",
        },
      }),
      startHarness({
        holdStartupHistory: true,
      }),
    ]);
    const [mainBoot, compactBoot, thinkingOverrideBoot, slowBoot] = boots;
    if (mainBoot.status === "fulfilled") {
      fixture = mainBoot.value;
    }
    if (compactBoot.status === "fulfilled") {
      compactFooter = compactBoot.value;
    }
    if (thinkingOverrideBoot.status === "fulfilled") {
      thinkingOverride = thinkingOverrideBoot.value;
    }
    if (slowBoot.status === "fulfilled") {
      slowStartup = slowBoot.value;
    }
    const failedBoot = boots.find((boot) => boot.status === "rejected");
    if (failedBoot) {
      throw failedBoot.reason;
    }
    await fixture.wait("local ready", STARTUP_TIMEOUT_MS);
  }, STARTUP_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await disposeActiveTuiFixtures();
    for (const started of [fixture, compactFooter, thinkingOverride, slowStartup]) {
      await (started as Awaited<ReturnType<typeof startHarness>> | undefined)?.cleanup();
    }
  }, STARTUP_TEST_TIMEOUT_MS);

  it(
    "renders a compact model and active thinking level in the footer",
    async () => {
      await compactFooter.wait("gpt-5.6-sol high", STARTUP_TIMEOUT_MS);
      expect(compactFooter.output()).not.toContain("openai:setup-64cddea3");
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the launch thinking override active across session-level changes",
    async ({ signal }) => {
      const footerNeedle = "fixture-provider/fixture-model high | deliver:off | tokens";
      await thinkingOverride.wait(footerNeedle, STARTUP_TIMEOUT_MS);
      await thinkingOverride.wait("PTY_RESPONSE: thinking override proof", STARTUP_TIMEOUT_MS);
      expect(
        await thinkingOverride.hasCall("sendChat", {
          message: "thinking override proof",
          thinking: "high",
        }),
      ).toBe(true);
      await thinkingOverride.write("/think low\r");
      await thinkingOverride.call(signal, "patchSession", { thinkingLevel: "low" });
      const sessionChangeOutputOffset = thinkingOverride.output().length;
      await thinkingOverride.write("second thinking override proof\r");
      await thinkingOverride.wait(
        "PTY_RESPONSE: second thinking override proof",
        STARTUP_TIMEOUT_MS,
      );
      expect(
        await thinkingOverride.hasCall("sendChat", {
          message: "second thinking override proof",
          thinking: "high",
        }),
      ).toBe(true);
      const outputAfterSessionChange = thinkingOverride.output().slice(sessionChangeOutputOffset);
      expect(outputAfterSessionChange).toContain(footerNeedle);
      expect(outputAfterSessionChange).not.toContain(
        "fixture-provider/fixture-model low | deliver:off | tokens",
      );
      expect(outputAfterSessionChange).not.toContain(
        "fixture-provider/fixture-model medium | deliver:off | tokens",
      );
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "shows startup activity while post-connect initialization is pending",
    async ({ signal }) => {
      await exerciseStartupHistoryRendering(slowStartup, STARTUP_TIMEOUT_MS, signal);
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  registerTuiReconnectTests({
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    testTimeoutMs: TEST_TIMEOUT_MS,
    startupTestTimeoutMs: STARTUP_TEST_TIMEOUT_MS,
  });

  it.each([{ failures: 4 }])(
    "recovers session subscription after $failures startup failures",
    async ({ failures }) => {
      await withFixture(
        { OPENCLAW_TUI_PTY_SUBSCRIBE_FAILURES: String(failures) },
        async (subscription) => {
          await subscription.wait("local ready | idle", STARTUP_TIMEOUT_MS);
          const entries = await subscription.records();
          expect(countFixtureCalls(entries, "subscribeSessionEvents")).toBe(failures + 1);
          expect(countFixtureCalls(entries, "subscribeSessionFailure")).toBe(failures);

          await subscription.write("after subscription recovery proof\r");
          await subscription.wait(
            "PTY_RESPONSE: after subscription recovery proof",
            STARTUP_TIMEOUT_MS,
          );
        },
      );
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "blocks submits after subscription exhaustion until reconnect succeeds",
    async ({ signal }) => {
      await withFixture(
        {
          OPENCLAW_TUI_PTY_SUBSCRIBE_FAILURES: "5",
          OPENCLAW_TUI_PTY_SUBSCRIBE_RECONNECT: "1",
        },
        async (subscription) => {
          await subscription.wait("session event subscribe failed", STARTUP_TIMEOUT_MS);
          const entries = await subscription.records();
          expect(countFixtureCalls(entries, "subscribeSessionEvents")).toBe(5);
          expect(countFixtureCalls(entries, "subscribeSessionFailure")).toBe(5);
          expect(entries.some(fixtureEntry("loadHistory"))).toBe(false);
          expect(subscription.output()).not.toContain("local ready | idle");

          const message = "after subscription reconnect proof";
          await subscription.write(`${message}\r`, { delay: false });
          await subscription.wait("local runtime not ready — message not sent", STARTUP_TIMEOUT_MS);
          const blockedEntries = await subscription.records();
          expect(countFixtureMessages(blockedEntries, message)).toBe(0);

          await subscription.write("\x03", { delay: false });
          await subscription.wait("cleared input", STARTUP_TIMEOUT_MS);
          await subscription.write("/gateway-status\r", { delay: false });
          await subscription.call(signal, "subscriptionReconnect");
          await subscription.wait("local ready | idle", STARTUP_TIMEOUT_MS);
          await subscription.write(`${message}\r`, { delay: false });
          await subscription.wait(`PTY_RESPONSE: ${message}`, STARTUP_TIMEOUT_MS);
          const reconnectedEntries = await subscription.records();
          expect(countFixtureMessages(reconnectedEntries, message)).toBe(1);
        },
      );
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it("refreshes pending approvals before loading history", async () => {
    const entries = await fixture.records();
    const approvalRefreshIndex = entries.findIndex(fixtureEntry("listPluginApprovals"));
    const historyLoadIndex = entries.findIndex(fixtureEntry("loadHistory"));
    const taskRefreshIndex = entries.findIndex(fixtureEntry("listTaskSuggestions"));

    expect(approvalRefreshIndex).toBeGreaterThanOrEqual(0);
    expect(approvalRefreshIndex).toBeLessThan(historyLoadIndex);
    expect(taskRefreshIndex).toBeGreaterThanOrEqual(0);
    expect(taskRefreshIndex).toBeLessThan(historyLoadIndex);
  });

  it(
    "drives the real TUI terminal loop through typed and fragmented Unicode input",
    async () => {
      await fixture.write("hello from pty\r");
      await fixture.wait("PTY_RESPONSE: hello from pty");
      expect(await fixture.hasCall("sendChat", { message: "hello from pty" })).toBe(true);
      await exerciseFragmentedUnicodePrompt(startTuiFixture, STARTUP_TIMEOUT_MS);
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "renders each live assistant reply once without replaying stale history",
    async () => {
      await withFixture(
        { OPENCLAW_TUI_PTY_COLS: "220", OPENCLAW_TUI_PTY_ROWS: "50" },
        async (live) => {
          await live.wait("local ready", STARTUP_TIMEOUT_MS);
          await live.write("live reply dedupe proof: first\r", { delay: false });
          await live.wait("TUI_LIVE_FIRST");
          await live.write("live reply dedupe proof: second\r", { delay: false });
          const rows = await waitForSynchronizedFrameRows(
            live.run,
            (frame) => frame.some((row) => row.includes("TUI_LIVE_SECOND")),
            STARTUP_TIMEOUT_MS,
          );
          const assistantRows = rows.filter(
            (row) => row.includes("TUI_LIVE_FIRST") || row.includes("TUI_LIVE_SECOND"),
          );
          expect(assistantRows).toEqual(["TUI_LIVE_FIRST", "TUI_LIVE_SECOND"]);
        },
      );
    },
    STARTUP_TEST_TIMEOUT_MS,
  );
  // prettier-ignore
  const editorInputCases = [
    ["recalls submitted input history through literal terminal navigation", [["w", "history recall proof\r"], ["s", "history recall proof"], ["o", "PTY_RESPONSE: history recall proof"], ["w", "\u001b[A\u0005 edited\r"], ["s", "history recall proof edited"]]],
    ["applies literal terminal shortcuts before submitting editor input",
      [["w", "discard this input"], ["w", "\u0003"], ["o", "cleared input; press ctrl+c again to exit"], ["w", "shortcut kept input\r"], ["s", "shortcut kept input"], ["n", "discard this input"]]],
    ["handles bracketed paste and rejects the pasted submit while busy",
      [["w", "\u001b[200~bracketed paste proof\u001b[201~\r"], ["s", "bracketed paste proof"], ["o", "PTY_RESPONSE: bracketed paste proof"], ["w", "slow prompt\r"], ["s", "slow prompt"],
        ["w", "\u001b[200~busy pasted prompt\u001b[201~\r"], ["o", "agent is busy"], ["o", "PTY_RESPONSE: slow prompt"], ["n", "busy pasted prompt"]]],
    ["submits fragmented IME text and Kitty AltGr printable bytes", [["w", "日本"], ["w", "語 "], ["w", "\u001b[64::113;7u\u001b[8364::101;7u\r"], ["s", "日本語 @€"], ["o", "PTY_RESPONSE: 日本語 @€"]]],
  ] as const;
  it.for(editorInputCases)(
    "%s",
    { timeout: STARTUP_TEST_TIMEOUT_MS },
    async ([_name, steps], { signal }) => {
      const tui = await startHarness();
      try {
        await tui.wait("local ready", STARTUP_TIMEOUT_MS);
        for (const [action, value] of steps) {
          // prettier-ignore
          const sent = (entry: FixtureLogEntry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", value);
          // prettier-ignore
          await { w: () => tui.write(value, { delay: false }), o: () => tui.wait(value), s: () => tui.waitForLogEntry(sent, signal), n: async () => expect((await tui.records()).some(sent)).toBe(false) }[action]();
        }
      } finally {
        await tui.cleanup();
      }
    },
  );
  it.for([
    {
      name: "preserves consecutive backspaces received in the same terminal input chunk",
      chunks: ["abc\x7f\x7f\r"],
      message: "a",
      rejected: "ab",
    },
    {
      name: "deletes forward with Ctrl+D without exiting a nonempty terminal editor",
      chunks: ["keepXword", "\u001b[D".repeat(5), "\u0004", "\r"],
      message: "keepword",
      rejected: undefined,
    },
  ])("$name", { timeout: TEST_TIMEOUT_MS }, async ({ chunks, message, rejected }, { signal }) => {
    for (const chunk of chunks) {
      await fixture.write(chunk, { delay: false });
    }
    const sent = await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "sendChat" &&
        (objectFieldEquals(entry, "message", message) ||
          (rejected !== undefined && objectFieldEquals(entry, "message", rejected))),
      signal,
    );
    expect(sent.payload).toMatchObject({ message });
    await fixture.wait(`PTY_RESPONSE: ${message}`);
  });

  it(
    "cancels a buffered submit before Ctrl+D shutdown",
    async ({ signal }) => {
      await withFixture({ OPENCLAW_TUI_PTY_SUBMIT_BURST_WINDOW_MS: "500" }, async (buffered) => {
        const message = "buffered shutdown proof";
        await buffered.wait("local ready", STARTUP_TIMEOUT_MS);
        await buffered.write(`${message}\r`, { delay: false });
        await buffered.call(signal, "submitBurstCaptured", { value: message });

        await buffered.write("\u0004", { delay: false });
        expect((await buffered.run.waitForExit()).exitCode).toBe(0);

        const entries = await buffered.records();
        expect(entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: "stop" })]),
        );
        expect(entries.some(fixtureEntry("sendChat", { message }))).toBe(false);
      });
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it.for([
    { name: "Ctrl+D", input: "\u0004" },
    { name: "/exit", input: "/exit\r" },
  ])(
    "stops the real terminal cleanly when $name interrupts an active run",
    { timeout: STARTUP_TEST_TIMEOUT_MS },
    async ({ input }, { signal }) => {
      await withFixture(undefined, async (busy) => {
        await busy.wait("local ready", STARTUP_TIMEOUT_MS);
        await busy.write("slow prompt\r", { delay: false });
        await busy.call(signal, "sendChat", { message: "slow prompt" });

        await busy.write(input, { delay: false });

        expect((await busy.run.waitForExit()).exitCode).toBe(0);
        expect(await busy.records()).toEqual(
          expect.arrayContaining([expect.objectContaining({ method: "stop" })]),
        );
      });
    },
  );

  it.for(COMPACT_TERMINAL_SIZES)(
    "presents and resolves plugin approval in a %i×%i terminal",
    { timeout: STARTUP_TEST_TIMEOUT_MS },
    async ([cols, rows], { signal }) => {
      await withFixture(
        {
          OPENCLAW_TUI_PTY_COLS: String(cols),
          OPENCLAW_TUI_PTY_ROWS: String(rows),
        },
        async (compact) => {
          await compact.wait("local ready", STARTUP_TIMEOUT_MS);
          await approveWorkspaceSkill(compact, "skill approval proof", signal);
        },
      );
    },
  );

  it(
    "keeps Enter focused on model and session pickers beside a side result in a 20×18 terminal",
    async ({ signal }) => {
      await withFixture(
        {
          OPENCLAW_TUI_PTY_COLS: "20",
          OPENCLAW_TUI_PTY_ROWS: "18",
          OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        },
        async (picker) => {
          await picker.wait("local ready", STARTUP_TIMEOUT_MS);
          await picker.write("/btw picker focus proof\r", { delay: false });
          await picker.call(signal, "pickerSideResult");

          await picker.write("\u000c", { delay: false });
          await picker.call(signal, "listModels");
          await picker.write("\u001b[B", { delay: false });
          await picker.write("\r", { delay: false });
          await picker.call(signal, "patchSession", { model: "fixture-provider/fixture-model-2" });

          await picker.write("\u0010", { delay: false });
          await picker.call(signal, "listSessions", { purpose: "picker" });
          await picker.write("\u001b[B", { delay: false });
          await picker.write("\r", { delay: false });
          await picker.call(signal, "loadHistory", { sessionKey: "agent:main:picker-target" });

          await picker.write("picker target proof\r", { delay: false });
          const sent = await picker.call(signal, "sendChat", { message: "picker target proof" });
          expect(sent.payload).toMatchObject({ sessionKey: "agent:main:picker-target" });
        },
      );
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "recovers the visible conversation from session history after a Gateway event gap",
    async ({ signal }) => {
      await withFixture(undefined, async (gap) => {
        await gap.wait("local ready", STARTUP_TIMEOUT_MS);
        await gap.write("history gap proof\r");
        await gap.call(signal, "gapHistoryRecovered");
        await gap.wait("PTY_GAP_RECOVERED");
        const gapNotice = "gateway event gap: expected 4, got 5";
        await gap.wait(gapNotice);
        const recoveredOutput = gap.output();
        expect(recoveredOutput.lastIndexOf(gapNotice)).toBeGreaterThan(
          recoveredOutput.lastIndexOf("PTY_GAP_RECOVERED"),
        );

        await gap.write("after gap recovery proof\r");
        await gap.call(signal, "sendChat", { message: "after gap recovery proof" });
        await gap.wait("PTY_RESPONSE: after gap recovery proof");
      });
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "refreshes pending plugin approvals after an event gap",
    async ({ signal }) => {
      await fixture.write("skill approval gap proof\r");
      await fixture.call(signal, "listPluginApprovals", { pending: true });
      await fixture.wait("plugin approval: Apply workspace skill proposal");

      await fixture.write("\x1b[A", { delay: false });
      await fixture.write("\r");
      await fixture.call(signal, "resolvePluginApproval", { decision: "allow-once" });
      await fixture.wait("PTY_SKILL_APPROVAL_RESOLVED: allow-once");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts a suggested task in a new session from the TUI",
    async ({ signal }) => {
      await fixture.write("task suggestion proof\r");
      await fixture.wait("Start in a new session");
      await fixture.wait("Project: /repo/project");
      await fixture.wait("The adapter is unreachable and adds maintenance cost.");

      await fixture.write("\x1b[A", { delay: false });
      await fixture.write("\r", { delay: false });
      await fixture.wait("Press Enter again to start this task.");
      await fixture.write("\r", { delay: false });
      await fixture.call(signal, "acceptTaskSuggestion", { taskId: "task_pty" });
      await fixture.wait("session agent:main:task-pty");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders message-tool-only internal ui source replies in the terminal",
    async () => {
      await fixture.write("message tool only source reply proof\r");
      await fixture.wait("VISIBLE_TUI_SOURCE_REPLY_PROOF");
      expect(
        await fixture.hasCall("sendChat", { message: "message tool only source reply proof" }),
      ).toBe(true);
      expect(
        await fixture.hasCall("sourceReplyMetadata", { text: "VISIBLE_TUI_SOURCE_REPLY_PROOF" }),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders an attachment-only assistant reply without exposing its source",
    async ({ signal }) => {
      await fixture.write("attachment-only assistant proof\r");
      await fixture.call(signal, "attachmentOnlyComplete");
      await fixture.wait("Attached image");

      const rendered = fixture.output();
      expect(rendered).not.toContain("SECRET_PTY_IMAGE_BYTES");
      expect(rendered).not.toContain("SECRET_PTY_ARTIFACT");
      expect(rendered).not.toContain("/Users/operator/private");
    },
    TEST_TIMEOUT_MS,
  );

  // Keep these producer-matched cases data-driven because this harness is at its line budget.
  // prettier-ignore
  const terminalSafetyCases = [
    ["renders long Unicode output and copy-safe URLs in narrow real PTY frames", () => exerciseNarrowTerminalRendering(startTuiFixture, STARTUP_TIMEOUT_MS)],
    ["sanitizes ANSI OSC and C1 payloads across real PTY display boundaries", (signal: AbortSignal) => exerciseTerminalOutputSafety(startTuiFixture, STARTUP_TIMEOUT_MS, signal)],
  ] as const;
  it.for(terminalSafetyCases)(
    "%s",
    { timeout: STARTUP_TEST_TIMEOUT_MS },
    async ([_name, runCase], { signal }) => runCase(signal),
  );

  it.for([
    {
      name: "preserves xAI account limit errors in terminal output",
      message: "xai limit proof",
      output: ["monthly spending limit"],
      hidden: "Run /auth",
    },
    {
      name: "renders redacted, cause-aware send failures in the real terminal loop",
      message: "tui error redaction proof",
      output: ["send failed: gateway down", "Authorization: Bearer"],
      hidden: "sk-abcdefghijklmnopqrstuv",
    },
  ])("$name", { timeout: TEST_TIMEOUT_MS }, async ({ message, output, hidden }, { signal }) => {
    await fixture.write(`${message}\r`);
    await fixture.call(signal, "sendChat", { message });
    for (const text of output) {
      await fixture.wait(text);
    }
    expect(fixture.output()).not.toContain(hidden);
  });

  registerToolCardRenderingTests(startTuiFixture, STARTUP_TIMEOUT_MS, STARTUP_TEST_TIMEOUT_MS);

  it(
    "keeps an active session intact when /reset is submitted from the terminal",
    async ({ signal }) => {
      const priorResetCount = (await fixture.records()).filter(fixtureEntry("resetSession")).length;

      await fixture.write("slow reset proof\r");
      await fixture.call(signal, "sendChat", { message: "slow reset proof" });
      await fixture.write("/reset\r", { delay: false });
      await fixture.wait("abort the current run before /reset");

      const resetCalls = (await fixture.records()).filter(fixtureEntry("resetSession"));
      expect(resetCalls).toHaveLength(priorResetCount);
      await fixture.wait("PTY_RESPONSE: slow reset proof");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "submits a follow-up prompt while a run is streaming",
    async ({ signal }) => {
      await fixture.write("\x15", { delay: false });
      await fixture.write("streaming prompt\r");
      await fixture.wait("PTY_STREAMING: streaming prompt");
      await fixture.write("queued while streaming\r");
      await fixture.call(signal, "sendChat", { message: "queued while streaming" });
      await fixture.wait("PTY_RESPONSE: streaming prompt");
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["authenticates a streamed prefix before the complete ordered final frame", undefined],
    ["preserves streaming activity when Ctrl+C selects clear", "clear"],
    ["preserves streaming activity when Ctrl+C selects warn", "warn"],
  ] as const)(
    "%s",
    (_name, ctrlC) => exerciseStreamingRendering(startTuiFixture, STARTUP_TIMEOUT_MS, ctrlC),
    STARTUP_TEST_TIMEOUT_MS,
  );

  it(
    "ignores delayed aborts and streamed events from the previously selected session",
    async ({ signal }) => {
      const isolated = await startHarness();
      const sourceSessionKey = "agent:main:abort-source";
      const targetSessionKey = "agent:main:abort-target";

      try {
        await isolated.wait("local ready", STARTUP_TIMEOUT_MS);
        await isolated.write(`/session ${sourceSessionKey}\r`, { delay: false });
        await isolated.call(signal, "loadHistory", { sessionKey: sourceSessionKey });
        await isolated.write("cross-session abort source proof\r", { delay: false });
        await isolated.call(signal, "sendChat", { message: "cross-session abort source proof" });

        await isolated.write("/abort\r", { delay: false });
        await isolated.call(signal, "abortChat", { sessionKey: sourceSessionKey });
        const outputOffset = isolated.output().length;
        await isolated.write(`/session ${targetSessionKey}\r`, { delay: false });
        await isolated.call(signal, "loadHistory", { sessionKey: targetSessionKey });
        await isolated.call(signal, "abortResolved", { sessionKey: sourceSessionKey });
        await isolated.call(signal, "lateSessionEvent", {
          sessionKey: sourceSessionKey,
          state: "final",
        });

        const targetOutput = isolated.output().slice(outputOffset);
        expect(targetOutput).not.toContain("PTY_LATE_FOREIGN_DELTA");
        expect(targetOutput).not.toContain("PTY_LATE_FOREIGN_FINAL");

        await isolated.write("cross-session target proof\r", { delay: false });
        const sent = await isolated.call(signal, "sendChat", {
          message: "cross-session target proof",
        });
        expect(sent.payload).toMatchObject({ sessionKey: targetSessionKey });
        await isolated.wait("PTY_RESPONSE: cross-session target proof");
      } finally {
        await isolated.cleanup();
      }
    },
    STARTUP_TEST_TIMEOUT_MS,
  );

  it.for([
    ["lists and executes slash commands through authenticated real PTY frames", "slash-commands"],
    ["selects model and session pickers through authenticated real PTY frames", "pickers"],
    ["updates settings through an authenticated real PTY overlay", "settings"],
  ] as const)("%s", { timeout: STARTUP_TEST_TIMEOUT_MS }, ([_name, surface], { signal }) =>
    exerciseTuiCommandSurface(startTuiFixture, surface, STARTUP_TIMEOUT_MS, signal),
  );

  it(
    "submits an exact argument completion with one Enter",
    async () => {
      await fixture.write("/fast status", { delay: false });
      await fixture.wait("→ status");
      await fixture.write("\r", { delay: false });
      await fixture.wait("fast mode: off");
    },
    TEST_TIMEOUT_MS,
  );

  it.for([
    { command: "verbose", level: "full", field: "verboseLevel" },
    { command: "reasoning", level: "stream", field: "reasoningLevel" },
  ])(
    "submits the canonical /$command $level terminal completion with one Enter",
    { timeout: TEST_TIMEOUT_MS },
    async ({ command, level, field }, { signal }) => {
      await fixture.write(`/${command} ${level}`, { delay: false });
      await fixture.wait(`→ ${level}`);
      await fixture.write("\r", { delay: false });

      await fixture.waitForLogEntry(
        (entry) => entry.method === "patchSession" && objectFieldEquals(entry, field, level),
        signal,
      );
    },
  );

  it.for([
    {
      provider: "Matrix",
      sessionKey: "agent:main:matrix:channel:!MixedRoomAbCdEf:example.org",
      message: "opaque session isolation proof: Matrix",
    },
    {
      provider: "Signal",
      sessionKey: "agent:main:signal:group:AbC123=",
      message: "opaque session isolation proof: Signal",
    },
  ])(
    "keeps case-distinct $provider conversations out of the visible terminal",
    { timeout: TEST_TIMEOUT_MS },
    async ({ sessionKey, message }, { signal }) => {
      await selectTuiFixtureSession(fixture, sessionKey, signal);

      const outputOffset = fixture.output().length;
      await fixture.write(`${message}\r`, { delay: false });
      const sent = await fixture.call(signal, "sendChat", { message });
      expect(sent.payload).toMatchObject({ sessionKey, message });
      await fixture.call(signal, "foreignSessionEvent");
      await fixture.wait(`PTY_RESPONSE: ${message}`);

      const sessionOutput = fixture.output().slice(outputOffset);
      expect(sessionOutput).toContain(`PTY_RESPONSE: ${message}`);
      expect(sessionOutput).not.toContain("PTY_FOREIGN_OPAQUE_SESSION_MESSAGE");
    },
  );

  it(
    "creates a backend session from /new and adopts its canonical key",
    async ({ signal }) => {
      await fixture.write("/new\r", { delay: false });
      await fixture.wait("new session: agent:main:tui-");
      const created = (await fixture.records()).find(fixtureEntry("createSession"));
      expect(created?.payload).toMatchObject({ agentId: "main" });
      expect(created?.payload).not.toHaveProperty("parentSessionKey");

      await fixture.write("after new\r", { delay: false });
      const sent = await fixture.call(signal, "sendChat", { message: "after new" });
      expect(sent.payload).toMatchObject({ sessionKey: expect.stringMatching(/^agent:main:tui-/) });
      await fixture.wait("PTY_RESPONSE: after new");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the newer session when a rapid switch's history resolves last",
    async ({ signal }) => {
      await fixture.write("/session agent:main:switch-a\r", { delay: false });
      await fixture.write("/session agent:main:switch-b\r", { delay: false });
      await fixture.wait("B_HISTORY_MARKER");
      await fixture.call(signal, "loadHistoryResolved", { sessionKey: "agent:main:switch-a" });

      await fixture.write("after switch\r", { delay: false });
      const sent = await fixture.call(signal, "sendChat", { message: "after switch" });
      expect(sent.payload).toMatchObject({ sessionKey: "agent:main:switch-b" });
      expect(fixture.output()).not.toContain("A_HISTORY_MARKER");
    },
    TEST_TIMEOUT_MS,
  );
});
