import { describe, expect, it } from "vitest";
import { createProgressLane } from "./controller.js";
import type { ProgressLaneConfig, ProgressLaneSink } from "./sink.js";

function makeSink(maxChars = 4096): {
  sink: ProgressLaneSink;
  updates: string[];
  spills: () => number;
} {
  const updates: string[] = [];
  let spills = 0;
  const sink: ProgressLaneSink = {
    maxChars,
    render: (body) => body, // pass the neutral body through for assertions
    update: (rendered) => {
      updates.push(rendered);
    },
    spill: () => {
      spills += 1;
    },
  };
  return { sink, updates, spills: () => spills };
}

const baseConfig: ProgressLaneConfig = {
  enabled: true,
  reasoning: true,
  commentary: false,
  toolRows: true,
  toolArgs: false,
  timer: true,
  timerIntervalMs: 20_000,
};

const FIXED_NOW = 1_000_000;
const lane = (sink: ProgressLaneSink, config: Partial<ProgressLaneConfig> = {}) =>
  createProgressLane({ sink, config: { ...baseConfig, ...config }, now: () => FIXED_NOW });

describe("createProgressLane", () => {
  it("emits nothing when disabled", () => {
    const { sink, updates } = makeSink();
    const l = lane(sink, { enabled: false });
    l.onReasoning("planning the approach");
    l.onTool("Bash", "ls -la");
    expect(updates).toHaveLength(0);
  });

  it("renders reasoning under a single Thinking header", () => {
    const { sink, updates } = makeSink();
    lane(sink).onReasoning("checking the model lists");
    expect(updates.at(-1)).toBe("Thinking\n\nchecking the model lists");
  });

  it("appends only the new suffix for cumulative reasoning snapshots (no dup)", () => {
    const { sink, updates } = makeSink();
    const l = lane(sink);
    l.onReasoning("step one");
    l.onReasoning("step one step two");
    expect(updates.at(-1)).toBe("Thinking\n\nstep one step two");
  });

  it("keeps commentary OUT by default, in when enabled", () => {
    const off = makeSink();
    lane(off.sink).onCommentary("here's the answer");
    expect(off.updates).toHaveLength(0);

    const on = makeSink();
    lane(on.sink, { commentary: true }).onCommentary("here's the answer");
    expect(on.updates.at(-1)).toContain("here's the answer");
  });

  it("appends a timestamped tool row; toolArgs gates the command detail", () => {
    const nameOnly = makeSink();
    lane(nameOnly.sink).onTool("Bash", "ssh host 'secret'");
    expect(nameOnly.updates.at(-1)).toMatch(/\n\[\d{2}:\d{2}:\d{2}\] tool: Bash/u);
    expect(nameOnly.updates.at(-1)).not.toContain("secret");

    const withArgs = makeSink();
    lane(withArgs.sink, { toolArgs: true }).onTool("Bash", "ssh host run");
    expect(withArgs.updates.at(-1)).toContain("ssh host run");
  });

  it("arms the rolling timer on a tool so later renders carry the still-running stamp", () => {
    const { sink, updates } = makeSink();
    const l = lane(sink);
    l.onTool("Bash"); // arms timer
    l.onReasoning("thinking while it runs");
    expect(updates.at(-1)).toMatch(/_\d+s — still running · \d{2}:\d{2}:\d{2}_$/u);
  });

  it("spills into a continuation message before the channel cap", () => {
    const { sink, updates, spills } = makeSink(120); // tiny cap to force rollover
    const l = lane(sink);
    for (let i = 0; i < 8; i += 1) {
      l.onReasoning(`${"x".repeat(30)} chunk ${i}\n`.repeat(i + 1));
    }
    expect(spills()).toBeGreaterThan(0);
    // every rendered message stays within the cap
    for (const u of updates) {
      expect(u.length).toBeLessThanOrEqual(120);
    }
  });

  it("never emits a bare header for a no-content turn", () => {
    const { sink, updates } = makeSink();
    const l = lane(sink);
    l.finalize("Done."); // no reasoning/tool ever appended
    expect(updates).toHaveLength(0);
  });

  it("strips a final answer that leaked into the lane at delivery", () => {
    const { sink, updates } = makeSink();
    const l = lane(sink, { commentary: true });
    l.onReasoning("weighing options");
    l.onTool("Bash"); // status checkpoint isolates the trailing answer block
    l.onCommentary("The answer is 42.");
    expect(updates.at(-1)).toContain("The answer is 42.");
    l.finalize("The answer is 42.");
    expect(updates.at(-1)).not.toContain("The answer is 42.");
    expect(updates.at(-1)).toContain("weighing options");
  });
});
