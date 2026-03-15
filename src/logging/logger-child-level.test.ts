import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getChildLogger, registerLogTransport, resetLogger, setLoggerOverride } from "./logger.js";

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
      const level = String(logObj._meta?.logLevelName ?? "").toUpperCase();
      const text = [logObj[0], logObj[1], logObj[2], logObj["0"], logObj["1"], logObj["2"]]
        .filter((v) => typeof v === "string")
        .join(" ");
      seen.push(`${level}:${text}`);
    });

    try {
      const child = getChildLogger({ module: "cron" });
      child.debug("cron: timer armed");
      child.info("cron: tick");
    } finally {
      unregister();
    }

    expect(seen.some((line) => line.includes("DEBUG:cron: timer armed"))).toBe(false);
    expect(seen.some((line) => line.includes("INFO:cron: tick"))).toBe(true);
  });

  it("respects explicit child level overrides", () => {
    const seen: string[] = [];
    const unregister = registerLogTransport((logObj) => {
      const level = String(logObj._meta?.logLevelName ?? "").toUpperCase();
      const text = [logObj[0], logObj[1], logObj[2], logObj["0"], logObj["1"], logObj["2"]]
        .filter((v) => typeof v === "string")
        .join(" ");
      seen.push(`${level}:${text}`);
    });

    try {
      const child = getChildLogger({ module: "cron" }, { level: "debug" });
      child.debug("cron: debug visible");
    } finally {
      unregister();
    }

    expect(seen.some((line) => line.includes("DEBUG:cron: debug visible"))).toBe(true);
  });
});
