import { describe, expect, it } from "vitest";
import { parseLogLine } from "./assemble-context.js";

describe("parseLogLine", () => {
  it("returns null for blank input", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("   ")).toBeNull();
  });

  it("extracts message from tslog string-only argument form", () => {
    const line = JSON.stringify({
      "0": "starting gateway on port 18789",
      _meta: { logLevelName: "INFO", date: "2026-04-21T10:00:00.000Z" },
      time: "2026-04-21 10:00:00.000",
    });
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry?.level).toBe("INFO");
    expect(entry?.subsystem).toBe("");
    expect(entry?.message).toBe("starting gateway on port 18789");
    expect(entry?.timestamp).toBe("2026-04-21 10:00:00.000");
  });

  it("extracts subsystem + message from tslog bindings-object form", () => {
    const line = JSON.stringify({
      "0": '{"subsystem":"gateway/ws"}',
      "1": "incoming connection accepted",
      _meta: { logLevelName: "WARN" },
      time: "2026-04-21 10:05:00.000",
    });
    const entry = parseLogLine(line);
    expect(entry?.level).toBe("WARN");
    expect(entry?.subsystem).toBe("gateway/ws");
    expect(entry?.message).toBe("incoming connection accepted");
  });

  it("joins multiple positional message parts with spaces", () => {
    const line = JSON.stringify({
      "0": "part one",
      "1": "part two",
      "2": "part three",
      _meta: { logLevelName: "ERROR" },
      time: "2026-04-21",
    });
    const entry = parseLogLine(line);
    expect(entry?.message).toBe("part one part two part three");
  });

  it("keeps JSON-looking strings without a subsystem field as message text", () => {
    const line = JSON.stringify({
      "0": '{"foo":"bar"}',
      _meta: { logLevelName: "INFO" },
      time: "2026-04-21",
    });
    const entry = parseLogLine(line);
    expect(entry?.subsystem).toBe("");
    expect(entry?.message).toBe('{"foo":"bar"}');
  });

  it("falls back to regex for plain-text lines", () => {
    const line = "2026-04-21T10:00:00.000Z [WARN] [gateway] restart triggered";
    const entry = parseLogLine(line);
    expect(entry?.level).toBe("WARN");
    expect(entry?.subsystem).toBe("gateway");
    expect(entry?.message).toBe("restart triggered");
  });

  it("returns null for unparseable lines", () => {
    expect(parseLogLine("not a log line")).toBeNull();
    expect(parseLogLine("{ broken json")).toBeNull();
  });
});
