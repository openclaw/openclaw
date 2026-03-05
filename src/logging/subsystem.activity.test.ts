import { afterEach, describe, expect, it, vi } from "vitest";
import { setConsoleActivityDetailMode } from "./console.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { createSubsystemLogger } from "./subsystem.js";

function renderConsoleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unrenderable]";
  }
}

afterEach(() => {
  setConsoleActivityDetailMode(false);
  setLoggerOverride(null);
  resetLogger();
  vi.restoreAllMocks();
});

describe("activity console style", () => {
  it("hides IDs in normal mode and shows them in full mode", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "debug", consoleStyle: "activity" });
    const log = createSubsystemLogger("agent/embedded");

    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      out.push(renderConsoleValue(value));
    });

    log.debug("embedded run tool end", {
      activity: {
        kind: "tool",
        summary: "Write AGENTS.md",
        runId: "run-123",
        toolCallId: "call-456",
        status: "ok",
      },
    });

    expect(out.join("\n")).toContain("Write AGENTS.md");
    expect(out.join("\n")).not.toContain("run-123");

    out.length = 0;
    setConsoleActivityDetailMode(true);

    log.debug("embedded run tool end", {
      activity: {
        kind: "tool",
        summary: "Write AGENTS.md",
        runId: "run-123",
        toolCallId: "call-456",
        status: "ok",
      },
    });

    expect(out.join("\n")).toContain("runId=run-123");
    expect(out.join("\n")).toContain("toolCallId=call-456");
  });

  it("keeps warn/error passthrough without activity metadata", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "debug", consoleStyle: "activity" });
    const log = createSubsystemLogger("agent/embedded");

    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((value?: unknown) => {
      warns.push(renderConsoleValue(value));
    });

    log.warn("plain warning line without activity");

    expect(warns.join("\n")).toContain("plain warning line without activity");
  });
});
