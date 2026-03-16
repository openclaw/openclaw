import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChildLogger, registerLogTransport, resetLogger, setLoggerOverride } from "./logger.js";

function captureLine(logObj: Record<string, unknown>): string {
  const meta = logObj["_meta"] as { logLevelName?: string } | undefined;
  const level = String(meta?.logLevelName ?? "").toUpperCase();
  const text = [logObj[0], logObj[1], logObj[2], logObj["0"], logObj["1"], logObj["2"]]
    .filter((v) => typeof v === "string")
    .join(" ");
  return `${level}:${text}`;
}

describe("getChildLogger", () => {
  beforeEach(() => {
    resetLogger();
    setLoggerOverride({ level: "info" });
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("inherits parent minLevel when child level is not explicitly set", () => {
    const seen: string[] = [];
    const unregister = registerLogTransport((logObj) => {
      seen.push(captureLine(logObj));
    });

    try {
      const child = getChildLogger({ module: "cron" });
      child.debug("cron: timer armed");
      child.info("cron: tick");
    } finally {
      unregister();
    }

    expect(seen.some((line) => line.includes("DEBUG:") && line.includes("cron: timer armed"))).toBe(
      false,
    );
    expect(seen.some((line) => line.includes("INFO:") && line.includes("cron: tick"))).toBe(true);
  });
});
