import { describe, expect, it } from "vitest";
import { parseLogLine } from "./logs.ts";

describe("parseLogLine", () => {
  it("strips ANSI escape codes from rendered message text", () => {
    const line = JSON.stringify({
      0: '{"subsystem":"gateway/ws\u001b[36m"}',
      2: "\u001b[31mclosed before connect\u001b[0m",
      _meta: {
        logLevelName: "WARN",
      },
    });

    expect(parseLogLine(line)).toEqual(
      expect.objectContaining({
        level: "warn",
        subsystem: "gateway/ws",
        message: "closed before connect",
      }),
    );
  });

  it("strips ANSI escape codes from plain text log lines", () => {
    expect(parseLogLine("\u001b[31mhello\u001b[0m")).toEqual({
      raw: "\u001b[31mhello\u001b[0m",
      message: "hello",
    });
  });

  it("prefers the human-readable message field when structured data is stored in slot 1", () => {
    const line = JSON.stringify({
      0: '{"subsystem":"gateway/ws"}',
      1: {
        cause: "unauthorized",
        authReason: "password_missing",
      },
      2: "closed before connect conn=abc code=4008 reason=connect failed",
      _meta: {
        date: "2026-03-13T19:07:12.128Z",
        logLevelName: "WARN",
      },
      time: "2026-03-13T14:07:12.138-05:00",
    });

    expect(parseLogLine(line)).toEqual(
      expect.objectContaining({
        level: "warn",
        subsystem: "gateway/ws",
        message: "closed before connect conn=abc code=4008 reason=connect failed",
      }),
    );
  });
});
