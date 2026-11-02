import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { PROGRESS_STATUS_PREAMBLE_FRESH_MS } from "../../channels/progress-draft-compositor.js";
import type { InternalGetReplyOptions as ReplyOptions } from "./get-reply.types.js";
import {
  generateNarrationWithUtilityModel as generateNarration,
  type ProgressNarrationInput,
} from "./progress-narrator-model.js";
type Lifecycle = Parameters<NonNullable<ReplyOptions["onProgressNarratorLifecycle"]>>[0];

const warnSpy = vi.hoisted(() => vi.fn());
const modelMocks = vi.hoisted(() => ({
  prepared: { provider: "openai", model: "gpt-5.5-mini" },
  prepare: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...mod,
    createSubsystemLogger: (name: string) => ({
      ...mod.createSubsystemLogger(name),
      warn: warnSpy,
    }),
  };
});

vi.mock("./progress-narrator-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./progress-narrator-model.js")>();
  return {
    ...actual,
    prepareNarrationModel: modelMocks.prepare,
    generateNarrationWithUtilityModel: modelMocks.generate,
  };
});

import { attachProgressNarratorToReplyOptions as attachNarrator } from "./progress-narrator.js";

const narratorCfg = { agents: { defaults: { utilityModel: "openai/gpt-5.5-mini" } } };

// The narrator runs generations on a detached promise; drain microtasks so
// onUpdate assertions observe the settled state.
async function flushNarrations() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function narratorHarness(params?: {
  texts?: Array<string | null>;
  abortSignal?: AbortSignal;
  now?: () => number;
  hideCommandText?: boolean;
  isProgressDraftVisible?: () => boolean;
  blocked?: boolean;
}) {
  const inputs: ProgressNarrationInput[] = [];
  const generation = createDeferred<string>();
  const started = createDeferred<AbortSignal | undefined>();
  const texts = params?.texts ?? ["Working on the request."];
  const generate = vi
    .mocked(generateNarration)
    .mockImplementation(async ({ input, abortSignal }) => {
      inputs.push(input);
      started.resolve(abortSignal);
      const text =
        params?.blocked && inputs.length === 1
          ? await generation.promise
          : (texts[Math.min(inputs.length - 1, texts.length - 1)] ?? null);
      return { text };
    });
  const onUpdate = vi.fn();
  if (params?.now) {
    vi.spyOn(Date, "now").mockImplementation(params.now);
  }
  const lifecycle: { current?: Lifecycle } = {};
  const wrapped = attachNarrator({
    cfg: narratorCfg,
    agentId: "main",
    userMessage: "change the default model",
    opts: {
      onNarrationUpdate: onUpdate,
      abortSignal: params?.abortSignal,
      onToolStart: vi.fn(),
      onItemEvent: vi.fn(),
      onProgressNarratorLifecycle: (value) => {
        lifecycle.current = value;
      },
      isProgressDraftVisible: params?.isProgressDraftVisible,
      narrationHideCommandText: params?.hideCommandText,
    },
  });
  if (!wrapped || !lifecycle.current) {
    throw new Error("expected attached progress narrator");
  }
  const controls = lifecycle.current;
  const narrator = {
    tool: (name: string) => void wrapped.onToolStart?.({ name, phase: "start" }),
    start: (name: string) => {
      void wrapped.onToolStart?.({ name, phase: "start" });
      return flushNarrations();
    },
    read: (path: string) =>
      void wrapped.onToolStart?.({ name: "read", phase: "start", args: { path } }),
    ...controls,
    replaceTurn: () => {
      controls.stopTurn();
      controls.beginTurn();
      void wrapped.onToolStart?.({ name: "read", phase: "start" });
    },
    preamble: (progressText: string) =>
      void wrapped.onItemEvent?.({ kind: "preamble", progressText }),
    failure: (title?: string, output?: string) =>
      void wrapped.onCommandOutput?.({ name: "exec", phase: "end", exitCode: 1, title, output }),
    noteToolStart: wrapped.onToolStart!,
  };
  return { narrator, generate, onUpdate, inputs, generation, started };
}

function deferPreparation() {
  const preparation = createDeferred<typeof modelMocks.prepared>();
  modelMocks.prepare.mockReturnValueOnce(preparation.promise);
  return preparation;
}

function deadlineClock() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return async (next: number, fireTimers = true) => {
    const elapsed = next - now;
    now = next;
    if (fireTimers) {
      await vi.advanceTimersByTimeAsync(elapsed);
    }
  };
}

function generatedRoutes() {
  const calls = vi.mocked(generateNarration).mock.calls;
  return calls.map(([{ prepared }]) => prepared.agentHarnessRuntimeOverride ?? "http");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(generateNarration).mockClear();
  modelMocks.prepare.mockResolvedValue(modelMocks.prepared);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  modelMocks.prepare.mockReset();
  modelMocks.generate.mockReset();
});

it.each([false, true])("retries hidden drafts with in-flight=%s", async (inFlight) => {
  let visible = true;
  const { narrator, generate, onUpdate, generation } = narratorHarness({
    blocked: true,
    texts: ["The command failed."],
    isProgressDraftVisible: () => visible,
  });

  await narrator.start("exec");
  if (!inFlight) {
    generation.resolve("Running a command.");
    await flushNarrations();
  }

  visible = false;
  narrator.failure();
  visible = true;
  generation.resolve("Running a command.");
  await flushNarrations();
  await vi.advanceTimersByTimeAsync(1_000);

  expect(generate).toHaveBeenCalledTimes(2);
  expect(onUpdate).toHaveBeenLastCalledWith({ text: "The command failed." });
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels retries at final and resets preamble freshness for a queued turn", async () => {
  let visible = false;
  const { narrator, generate, inputs } = narratorHarness({
    isProgressDraftVisible: () => visible,
  });

  narrator.preamble("Primary turn work.");
  narrator.tool("exec");
  expect(vi.getTimerCount()).toBe(1);

  narrator.stopTurn();
  expect(vi.getTimerCount()).toBe(0);
  narrator.beginTurn();
  visible = true;
  await narrator.start("read");

  expect(generate).toHaveBeenCalledTimes(1);
  expect(inputs[0]?.userMessage).toBe("");
});

it.each(["early", "late", "expired"])(
  "isolates stopped preparation: %s replacement",
  async (timing) => {
    const advance = deadlineClock();
    const preparation = deferPreparation();
    const { narrator, generate, onUpdate, inputs } = narratorHarness();
    narrator.tool("exec");
    if (timing === "expired") {
      await advance(10_000);
      narrator.tool("read");
      expect(generate).not.toHaveBeenCalled();
    }
    narrator.stopTurn();
    if (timing !== "late") {
      narrator.replaceTurn();
    }
    if (timing === "expired") {
      await advance(11_000);
    }
    preparation.resolve(modelMocks.prepared);
    await flushNarrations();
    if (timing === "late") {
      expect(generate).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      narrator.replaceTurn();
      await flushNarrations();
    }
    expect(modelMocks.prepare).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(inputs[0]).toMatchObject({ userMessage: "", activityNotes: ["Tool read"] });
    expect(onUpdate).toHaveBeenCalledOnce();
    if (timing === "expired") {
      expect(generateNarration).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 9_000 }));
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  { preparationMs: 4_000, timeoutMs: 6_000 },
  { preparationMs: 4_000.25, timeoutMs: 6_000 },
  { preparationMs: 9_999.75, timeoutMs: 1 },
  { preparationMs: 10_000, timeoutMs: 0 },
])("charges preparation to deadline: $preparationMs", async ({ preparationMs, timeoutMs }) => {
  const advance = deadlineClock();
  const preparation = deferPreparation();
  const { narrator, generate, onUpdate } = narratorHarness();

  narrator.tool("exec");
  await advance(preparationMs);
  preparation.resolve(modelMocks.prepared);
  await flushNarrations();

  if (timeoutMs > 0) {
    expect(generateNarration).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs }));
    expect(onUpdate).toHaveBeenCalledWith({ text: "Working on the request." });
  } else {
    expect(generate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("discards late narration: timer fired=%s", async (fireTimer) => {
  const advance = deadlineClock();
  const preparation = deferPreparation();
  const { narrator, generate, onUpdate, generation } = narratorHarness({ blocked: true });

  narrator.tool("exec");
  await advance(4_000);
  preparation.resolve(modelMocks.prepared);
  await flushNarrations();
  expect(generate).toHaveBeenCalledOnce();
  const signal = generate.mock.calls[0]?.[0].abortSignal;
  expect(signal?.aborted).toBe(false);

  await advance(10_000, fireTimer);
  expect(signal?.aborted).toBe(fireTimer);
  generation.resolve("This status arrived too late.");
  await flushNarrations();

  expect(onUpdate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "re-prepares invalid routes without evicting queued native work (borrowed=%s)",
  async (borrowed) => {
    modelMocks.prepare.mockResolvedValueOnce(
      borrowed ? { ...modelMocks.prepared, agentHarnessRuntimeOverride: "claude-cli" } : null,
    );
    const { narrator, onUpdate, generation } = narratorHarness({
      blocked: borrowed,
      texts: ["Current queued work."],
    });
    await narrator.start("exec");
    narrator.replaceTurn();
    await flushNarrations();
    generation.resolve("Stale primary work.");
    await flushNarrations();
    narrator.replaceTurn();
    await flushNarrations();
    expect(modelMocks.prepare).toHaveBeenCalledTimes(2);
    expect(generatedRoutes()).toEqual(borrowed ? ["claude-cli", "http", "http"] : ["http", "http"]);
    const update = [{ text: "Current queued work." }];
    expect(onUpdate.mock.calls).toEqual([update, update]);
  },
);

it.each([
  { action: "stop", pending: false },
  { action: "stop", pending: true },
  { action: "abort", pending: true },
])("cancels narration on $action (pending cadence=$pending)", async ({ action, pending }) => {
  const outer = new AbortController();
  const { narrator, generate, onUpdate, started, generation } = narratorHarness({
    abortSignal: outer.signal,
    blocked: !pending,
  });
  await narrator.start("read");
  const signal = await started.promise;
  try {
    expect(signal?.aborted).toBe(false);
    if (pending) {
      narrator.read("pending.txt");
      expect(vi.getTimerCount()).toBe(1);
    }
    if (action === "stop") {
      narrator.stopTurn();
    } else {
      outer.abort();
    }
    expect(signal?.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(action === "abort");
    await vi.advanceTimersByTimeAsync(12_000);
  } finally {
    generation.resolve("Stale status.");
    await flushNarrations();
  }
  expect(generate).toHaveBeenCalledOnce();
  expect(onUpdate).toHaveBeenCalledTimes(pending ? 1 : 0);
  expect(vi.getTimerCount()).toBe(0);
});

it("retries narration after preamble freshness expires without a new note", async () => {
  let nowMs = 0;
  const { narrator, generate, inputs } = narratorHarness({ now: () => nowMs });

  narrator.preamble("Checking   the current configuration.");
  await narrator.start("read");
  expect(generate).not.toHaveBeenCalled();

  nowMs = PROGRESS_STATUS_PREAMBLE_FRESH_MS + 1;
  await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS + 1);
  await flushNarrations();

  expect(inputs[0]?.activityNotes).toContain("Assistant: Checking the current configuration.");
});

it.each(["NO_REPLY", "[[audio_as_voice]] _NO_REPLY_"])("literal progress: %s", async (text) => {
  const { narrator, generate } = narratorHarness();

  narrator.preamble("[[reply_to_current]]");
  narrator.preamble(text);
  await narrator.noteToolStart({ name: "exec", phase: "start", args: { command: "ls" } });
  await flushNarrations();

  expect(generate).not.toHaveBeenCalled();
});

it("coalesces a burst of notes at the cadence boundary", async () => {
  const { narrator, generate, onUpdate, inputs, started, generation } = narratorHarness({
    blocked: true,
    texts: ["Checking the latest file."],
  });

  narrator.read("first.txt");
  await started.promise;
  for (let index = 0; index < 4; index += 1) {
    narrator.read(`later-${index}.txt`);
  }
  generation.resolve("Inspecting the first file.");
  await flushNarrations();

  expect(generate).toHaveBeenCalledOnce();
  expect(onUpdate).toHaveBeenLastCalledWith({ text: "Inspecting the first file." });
  await vi.advanceTimersByTimeAsync(6_000);
  narrator.read("latest.txt");
  await vi.advanceTimersByTimeAsync(5_999);
  expect(generate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);

  expect(generate).toHaveBeenCalledTimes(2);
  expect(inputs[1]?.activityNotes.at(-1)).toBe('Tool read: {"path":"latest.txt"}');
  expect(onUpdate).toHaveBeenLastCalledWith({ text: "Checking the latest file." });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "narrates failures immediately and respects command privacy (hidden=%s)",
  async (hideCommandText) => {
    const { narrator, generate, onUpdate, inputs } = narratorHarness({
      hideCommandText,
      texts: ["Running a command.", "The command failed, retrying."],
    });
    for (const name of ["exec", "shell", "server.exec"]) {
      await narrator.noteToolStart({ name, phase: "start", args: { command: "cat /etc/hosts" } });
    }
    await flushNarrations();
    narrator.read("pending.txt");
    narrator.failure("cat /etc/hosts", "private command output must not reach narration");
    await flushNarrations();
    expect(generate).toHaveBeenCalledTimes(2);
    const notes = inputs[1]?.activityNotes.join("\n") ?? "";
    expect(notes).toContain(`${hideCommandText ? "exec" : "cat /etc/hosts"}: failed (exit 1)`);
    if (hideCommandText) {
      expect(notes).not.toContain("/etc/hosts");
    }
    expect(notes).not.toContain("private command output");
    expect(onUpdate).toHaveBeenLastCalledWith({ text: "The command failed, retrying." });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([false, true])("disables after failures with prior success=%s", async (succeeded) => {
  warnSpy.mockClear();
  let nowMs = 0;
  const { narrator, generate, onUpdate } = narratorHarness({
    texts: succeeded ? ["Status one.", null, null] : [null],
    now: () => nowMs,
  });
  for (let i = 0; i < (succeeded ? 3 : 4); i += 1) {
    await narrator.start("exec");
    nowMs += 13_000;
  }
  if (succeeded) {
    expect(onUpdate).toHaveBeenNthCalledWith(1, { text: "Status one." });
    expect(onUpdate).toHaveBeenLastCalledWith({ text: "" });
  } else {
    expect(generate).toHaveBeenCalledTimes(2);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
      "narration disabled after 2 consecutive failures",
    );
  }
});

it.each([
  { name: "no utility model", cfg: {}, disabled: undefined },
  { name: "model-locked session", cfg: narratorCfg, disabled: true },
])("returns options unchanged: $name", ({ cfg, disabled }) => {
  const opts: ReplyOptions = { onNarrationUpdate: vi.fn(), onToolStart: vi.fn() };
  expect(attachNarrator({ cfg, disabled, agentId: "main", opts })).toBe(opts);
});

it("tees tool events while preserving the channel callback results", async () => {
  const onToolStart = vi.fn(async () => {});
  const onItemEvent = vi.fn(() => false as const);
  const opts: ReplyOptions = { onNarrationUpdate: vi.fn(), onToolStart, onItemEvent };
  const wrapped = attachNarrator({ cfg: narratorCfg, agentId: "main", opts });

  expect(wrapped).not.toBe(opts);
  // Non-work tool: the narrator ignores it, the channel still hears it.
  await wrapped?.onToolStart?.({ name: "message", phase: "start" });
  expect(onToolStart).toHaveBeenCalledWith({ name: "message", phase: "start" });
  await expect(
    Promise.resolve(wrapped?.onItemEvent?.({ itemId: "i1", status: "completed" })),
  ).resolves.toBe(false);
  expect(onItemEvent).toHaveBeenCalledWith({ itemId: "i1", status: "completed" });
});
