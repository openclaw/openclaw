// Reproduces the claude-cli live-session progress-preview timeline in "progress"
// streaming mode and locks in the fix for the two reported defects:
//   (1) "disappears too fast / stale": claude-cli forwards the FULL reasoning-so-
//       far for the turn on every thinking delta (src/agents/cli-output.ts keeps
//       accumulating reasoningText). The fix has two parts that together keep the
//       preview live and current:
//         - src/auto-reply/reply/agent-runner-execution.ts now forwards
//           isReasoningSnapshot: true, so the compositor REPLACES (not
//           concatenates) the reasoning buffer — no more run-on across blocks.
//         - this file's compositor now truncates the reasoning preview line from
//           the TAIL, so the LATEST thought stays visible instead of the oldest
//           one being pinned while new reasoning is dropped off the end.
//   (2) "silent gap during tools": there are no compositor updates while a tool
//       executes (tool result is suppressed by the dispatch and claude-cli emits
//       no commentary/keepalive). This is an event-density property of the
//       runtime (Codex has the same waiting-on-tool gap) and is documented, not
//       "fixed" here — but reasoning streamed *between* tools is now visible
//       because the latest thought is no longer truncated away.
//
// Codex parity reference: extensions/codex/src/app-server/event-projector.ts
// emits reasoning with isReasoningSnapshot: true; this brings claude-cli to the
// same contract.
import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

type RenderedDraft = { text: string };

function createHarness() {
  const renders: RenderedDraft[] = [];
  const update = vi.fn((text: string) => {
    renders.push({ text });
  });
  const deleteCurrent = vi.fn();
  const progress = createChannelProgressDraftCompositor({
    entry: { streaming: { mode: "progress", progress: { label: "Working" } } },
    mode: "progress",
    active: true,
    seed: "test",
    update,
    deleteCurrent,
  });
  const lastText = () => renders.at(-1)?.text;
  return { progress, update, deleteCurrent, renders, lastText };
}

const TOOL_LINE = "🛠️ Bash";

// Mirrors the post-fix claude-cli runtime: each push carries the FULL
// reasoning-so-far for the turn AND is flagged as a snapshot.
function cumulativeClaudeCliReasoning(progress: ReturnType<typeof createHarness>["progress"]) {
  let soFar = "";
  return (deltaThinking: string) => {
    // src/agents/cli-output.ts joins thinking deltas with NO separator.
    soFar = `${soFar}${deltaThinking}`;
    // agent-runner-execution.ts now forwards isReasoningSnapshot: true.
    return progress.pushReasoningProgress(soFar, { snapshot: true });
  };
}

describe("claude-cli progress preview timeline", () => {
  it("FIX (1): the reasoning preview shows the LATEST thought, not the oldest, as it grows", async () => {
    const h = createHarness();
    const reason = cumulativeClaudeCliReasoning(h.progress);

    const block1 =
      "Reading the project configuration to understand how the streaming progress " +
      "preview is wired together before I touch anything at all here ";
    // Two deltas so the gate (two-event rule) starts the draft.
    await reason(block1.slice(0, 40));
    await reason(block1.slice(40));
    const afterBlock1 = h.lastText() ?? "";

    // The latest thought (the TAIL of the cumulative reasoning) is now visible,
    // and the truncation marker leads instead of trailing.
    expect(afterBlock1).toContain("before I touch anything");
    expect(afterBlock1).toContain("…");
    // The oldest words are dropped now that the line exceeds the budget.
    expect(afterBlock1).not.toContain("Reading the project configuration");

    // A tool runs, then a SECOND thinking block streams. With snapshot semantics
    // the buffer is replaced (no run-on), and the tail truncation reveals the new
    // thought immediately.
    await h.progress.pushToolProgress(TOOL_LINE, { startImmediately: true });
    await reason("Now I will edit the compositor to fix the truncation behaviour");
    const afterBlock2 = h.lastText() ?? "";
    expect(afterBlock2).toContain("Now I will edit the compositor");
    // No leftover run-on from the first block.
    expect(afterBlock2).not.toContain("Reading the project configuration");
    // The tool line is still present above the reasoning.
    expect(afterBlock2).toContain("🛠️ Bash");
  });

  it("FIX (1): snapshot reasoning replaces the buffer instead of concatenating across blocks", async () => {
    const h = createHarness();

    await h.progress.pushToolProgress(TOOL_LINE, { startImmediately: true });
    await h.progress.pushReasoningProgress("First thought here", { snapshot: true });
    expect(h.lastText()).toBe("Working\n\n🛠️ Bash\n• _First thought here_");

    // A later snapshot from a new thinking block replaces the previous reasoning
    // line in place — short reasoning is shown verbatim, with no concatenation.
    await h.progress.pushReasoningProgress("Second distinct thought", { snapshot: true });
    expect(h.lastText()).toBe("Working\n\n🛠️ Bash\n• _Second distinct thought_");
  });

  it("DOCUMENTS effect (2): no preview update happens during the tool-execution gap", async () => {
    const h = createHarness();

    await h.progress.pushToolProgress(TOOL_LINE, { startImmediately: true });
    const rendersAfterToolStart = h.renders.length;

    // Tool RESULT is suppressed by the dispatch and claude-cli emits no
    // commentary/keepalive in this window, so the compositor receives nothing.
    // (We push nothing, emulating the dispatch.) The preview is unchanged until
    // the next reasoning/tool event arrives. This mirrors Codex's behavior while
    // a tool is actually executing.
    expect(h.renders.length).toBe(rendersAfterToolStart);
    expect(h.lastText()).toBe("Working\n\n🛠️ Bash");
  });
});
