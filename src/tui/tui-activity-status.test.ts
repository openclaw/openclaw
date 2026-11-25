// Verifies the TUI run lifecycle maps onto Program Status Protocol (OSC 7501) states.
import { describe, expect, it } from "vitest";
import { createTuiProgramStatusReporter, type TuiRunOutcome } from "./tui-activity-status.js";

function createRecorder() {
  const reports: Array<{ state: string }> = [];
  const reporter = createTuiProgramStatusReporter({
    setProgramStatus: (status) => reports.push(status),
  });
  const set = (activityStatus: string, isConnected = true, runOutcome?: TuiRunOutcome) =>
    reporter.update({ activityStatus, isConnected, runOutcome });
  const states = () => reports.map((report) => report.state);
  return { reports, set, states };
}

describe("tui program status", () => {
  it("reports working during a run and done when it completes", () => {
    const { reports, set, states } = createRecorder();
    set("starting up");
    set("idle");
    set("sending");
    set("waiting");
    set("streaming");
    set("running");
    set("finishing context");
    set("idle", true, "completed");
    expect(states()).toEqual(["idle", "working", "done"]);
    expect(reports[2]).toEqual({ state: "done", app: "openclaw" });
  });

  it("keeps an unseen done result through repeated idle and display-only updates", () => {
    const { set, states } = createRecorder();
    set("running");
    set("idle", true, "completed");
    set("idle");
    set("tools expanded");
    set("idle");
    expect(states()).toEqual(["working", "done"]);
  });

  it("reports idle for an aborted run and error for a failed run", () => {
    const { set, states } = createRecorder();
    set("running");
    set("aborted");
    set("streaming");
    set("error");
    set("idle");
    set("sending");
    set("abort failed");
    expect(states()).toEqual(["working", "idle", "working", "error", "working", "error"]);
  });

  it("does not claim done when the transport drops mid-run", () => {
    const { set, states } = createRecorder();
    set("streaming");
    set("idle", false);
    set("running");
    set("gateway authentication needs attention", false);
    expect(states()).toEqual(["working", "idle", "working", "idle"]);
  });

  it("does not infer completion from display idle, but accepts a recovered outcome", () => {
    const { set, states } = createRecorder();
    set("streaming");
    set("idle");
    set("streaming");
    set("idle", false, "aborted");
    set("streaming");
    set("idle", false, "completed");
    expect(states()).toEqual(["working", "idle", "working", "idle", "working", "done"]);
  });

  it("survives a terminal write failure", () => {
    const reporter = createTuiProgramStatusReporter({
      setProgramStatus: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => reporter.update({ activityStatus: "running", isConnected: true })).not.toThrow();
  });
});
