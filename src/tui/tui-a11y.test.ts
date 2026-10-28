import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createA11yStatusReporter,
  noForcedRender,
  resolveTuiA11y,
  setupTuiA11y,
} from "./tui-a11y.js";

const configOn = { ui: { tui: { screenReader: true } } } as OpenClawConfig;
const configOff = { ui: { tui: { screenReader: false } } } as OpenClawConfig;

describe("resolveTuiA11y", () => {
  it("defaults to off", () => {
    expect(resolveTuiA11y({})).toEqual({ screenReader: false });
    expect(resolveTuiA11y({ config: {} as OpenClawConfig })).toEqual({ screenReader: false });
  });

  it("enables from the flag even when config is off", () => {
    expect(resolveTuiA11y({ flag: true, config: configOff })).toEqual({ screenReader: true });
  });

  it("enables from config alone", () => {
    expect(resolveTuiA11y({ config: configOn })).toEqual({ screenReader: true });
  });

  it("stays off when the flag is false and config is off", () => {
    expect(resolveTuiA11y({ flag: false, config: configOff })).toEqual({ screenReader: false });
  });
});

describe("createA11yStatusReporter", () => {
  const setup = () => {
    const lines: string[] = [];
    const bell = vi.fn();
    const reporter = createA11yStatusReporter({ addLine: (t) => lines.push(t), bell });
    return { lines, bell, reporter };
  };

  it("stays silent through startup", () => {
    const { lines, bell, reporter } = setup();
    reporter.update("starting up");
    reporter.update("idle");
    expect(lines).toEqual([]);
    expect(bell).not.toHaveBeenCalled();
  });

  it("announces a run and rings once at the end", () => {
    const { lines, bell, reporter } = setup();
    for (const status of ["sending", "waiting", "streaming", "streaming", "idle"]) {
      reporter.update(status);
    }
    expect(lines).toEqual(["Working", "Status: waiting", "Status: streaming", "Done in 0s"]);
    expect(bell).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated statuses and rings only for error and abort failure", () => {
    const { lines, bell, reporter } = setup();
    reporter.update("streaming");
    reporter.update("streaming");
    expect(lines).toEqual(["Working"]);
    for (const status of [
      "aborted",
      "idle",
      "running",
      "abort failed",
      "idle",
      "running",
      "error",
    ]) {
      reporter.update(status);
    }
    expect(
      lines.filter((line) => line.startsWith("Status: a") || line === "Status: error"),
    ).toEqual(["Status: aborted", "Status: abort failed", "Status: error"]);
    expect(bell).toHaveBeenCalledTimes(2);
  });
});

describe("setupTuiA11y", () => {
  it("announces screen reader mode once at launch, and only when it is on", async () => {
    const { default: chalk } = await import("chalk");
    const saved = chalk.level;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      chalk.level = 3;
      setupTuiA11y({ flag: false });
      expect(write).not.toHaveBeenCalled();
      expect(chalk.bold("x")).not.toBe("x");
      setupTuiA11y({ flag: true });
      expect(write).toHaveBeenCalledExactlyOnceWith("Screen reader mode on\n");
    } finally {
      write.mockRestore();
      chalk.level = saved;
    }
  });
});

describe("noForcedRender", () => {
  it("drops the force flag so finished runs keep differential rendering", () => {
    const tui = { requestRender: vi.fn() };
    noForcedRender(tui).requestRender(true);
    expect(tui.requestRender.mock.calls).toEqual([[]]);
  });
});
