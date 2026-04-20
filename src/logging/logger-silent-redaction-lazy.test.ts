import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const resolvedRedaction = { mode: "tools" as const, patterns: [/Bearer\s+[A-Za-z0-9._\-+=]+/g] };

const { resolveRedactOptionsMock } = vi.hoisted(() => ({
  resolveRedactOptionsMock: vi.fn(() => resolvedRedaction),
}));

vi.mock("./redact.js", async () => {
  const actual = await vi.importActual<typeof import("./redact.js")>("./redact.js");
  return {
    ...actual,
    resolveRedactOptions: () => resolveRedactOptionsMock(),
  };
});

let logging: typeof import("../logging.js");
let loggerModule: typeof import("./logger.js");

beforeAll(async () => {
  logging = await import("../logging.js");
  loggerModule = await import("./logger.js");
});

afterEach(() => {
  logging.resetLogger();
  logging.setLoggerOverride(null);
  resolveRedactOptionsMock.mockClear();
  vi.restoreAllMocks();
});

describe("silent logger redaction is lazy", () => {
  it("does not resolve redaction when silent and no external transport is registered", () => {
    logging.setLoggerOverride({ level: "silent", file: "unused.log", consoleLevel: "silent" });

    logging.getLogger();

    expect(resolveRedactOptionsMock).toHaveBeenCalledTimes(0);
  });

  it("resolves redaction exactly once when silent with external transports", () => {
    logging.setLoggerOverride({ level: "silent", file: "unused.log", consoleLevel: "silent" });
    const records: Array<Record<string, unknown>> = [];
    const unregister = loggerModule.registerLogTransport((record) => {
      records.push(record);
    });

    logging.getLogger();

    // registerLogTransport triggers exactly one resolve for the late attach;
    // buildLogger on the silent path must not add a second resolve.
    expect(resolveRedactOptionsMock).toHaveBeenCalledTimes(1);

    unregister();
  });
});
