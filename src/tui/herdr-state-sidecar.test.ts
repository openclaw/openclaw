// Tests for Herdr/OpenClaw TUI state bridge detection and lifecycle.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectHerdrOpenClawState,
  readHerdrPane,
  reportHerdrState,
  startHerdrStateSidecar,
} from "./herdr-state-sidecar.js";

describe("herdr state sidecar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects idle, working elapsed labels, blocked approval, and unknown states", () => {
    expect(detectHerdrOpenClawState("gateway connected | idle")).toEqual({
      state: "idle",
      customStatus: "",
    });
    expect(detectHerdrOpenClawState("⠼ dillydallying… • 1m 19s | connected")).toEqual({
      state: "working",
      customStatus: "1m 19s",
    });
    expect(detectHerdrOpenClawState("⠼ pondering… • 8s | connected")).toEqual({
      state: "working",
      customStatus: "8s",
    });
    expect(detectHerdrOpenClawState("Approve this command? Allow once")).toEqual({
      state: "blocked",
      customStatus: "awaiting-approval",
    });
    expect(detectHerdrOpenClawState("plain terminal text")).toEqual({
      state: "unknown",
      customStatus: "",
    });
  });

  it("reads the visible Herdr pane", async () => {
    const exec = vi.fn(async () => ({ stdout: "content", stderr: "" }));

    await expect(readHerdrPane({ paneId: "pane-1", exec })).resolves.toBe("content");

    expect(exec).toHaveBeenCalledWith(
      "herdr",
      ["pane", "read", "pane-1", "--source", "visible", "--lines", "80"],
      { timeout: 5000 },
    );
  });

  it("reports custom OpenClaw state to Herdr", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await reportHerdrState({
      paneId: "pane-1",
      report: { state: "working", customStatus: "1m 19s" },
      exec,
    });

    expect(exec).toHaveBeenCalledWith(
      "herdr",
      [
        "pane",
        "report-agent",
        "pane-1",
        "--source",
        "custom:openclaw",
        "--agent",
        "openclaw",
        "--state",
        "working",
        "--custom-status",
        "1m 19s",
      ],
      { timeout: 5000 },
    );
  });

  it("no-ops when Herdr env is missing or the bridge is disabled", () => {
    expect(startHerdrStateSidecar({ env: {} })).toBeNull();
    expect(
      startHerdrStateSidecar({
        env: { HERDR_PANE_ID: "pane-1", OPENCLAW_HERDR_STATE_DISABLE: "1" },
      }),
    ).toBeNull();
  });

  it("dedupes reports and stops when pane disappears", async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "gateway connected | idle", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "gateway connected | idle", stderr: "" })
      .mockRejectedValueOnce(new Error("pane not found"));
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const handle = startHerdrStateSidecar({
      env: { HERDR_PANE_ID: "pane-1", OPENCLAW_HERDR_STATE_INTERVAL_MS: "250" },
      exec,
      logger,
    });

    expect(handle).not.toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);

    const reportCalls = exec.mock.calls.filter(
      (call) => call[1]?.[0] === "pane" && call[1]?.[1] === "report-agent",
    );
    expect(reportCalls).toHaveLength(1);
    expect(logger.debug).toHaveBeenCalledWith("herdr-state: pane pane-1 gone; stopping");
    handle?.stop();
  });
});
