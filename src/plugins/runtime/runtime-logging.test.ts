// Runtime logging tests cover plugin runtime log routing and verbosity behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggingMocks = vi.hoisted(() => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const diagnosticSource = {
    filePath: "extensions/discord/src/monitor.ts",
    functionName: "handleMessage",
    line: 42,
  };
  type DiagnosticSourceCaptureOptions = {
    ignoredMethods?: string[];
    ignoredPathSuffixes?: string[];
  };
  const attachDiagnosticLogSource = vi.fn((meta: Record<string, unknown>, source: unknown) => ({
    ...meta,
    __diagnosticSource: source,
  }));
  const attachDiagnosticLogSemantics = vi.fn(
    (meta: Record<string, unknown>, semantics: unknown) => ({
      ...meta,
      __diagnosticSemantics: semantics,
    }),
  );
  const hasDiagnosticLogSemantics = vi.fn((meta: Record<string, unknown>) =>
    Object.hasOwn(meta, "__diagnosticSemantics"),
  );
  const readAttachedDiagnosticLogSource = vi.fn((meta: Record<string, unknown>) =>
    Reflect.get(meta, "__diagnosticSource"),
  );
  const captureDiagnosticLogSource = vi.fn<
    (options?: DiagnosticSourceCaptureOptions) => typeof diagnosticSource | undefined
  >(() => diagnosticSource);
  const isFileLogLevelEnabled = vi.fn((_level: string) => true);
  return {
    attachDiagnosticLogSemantics,
    attachDiagnosticLogSource,
    captureDiagnosticLogSource,
    childLogger,
    diagnosticSource,
    getChildLogger: vi.fn(() => childLogger),
    hasDiagnosticLogSemantics,
    isFileLogLevelEnabled,
    readAttachedDiagnosticLogSource,
  };
});

vi.mock("../../globals.js", () => ({
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("../../logging.js", () => ({
  getChildLogger: loggingMocks.getChildLogger,
  isFileLogLevelEnabled: loggingMocks.isFileLogLevelEnabled,
}));

vi.mock("../../logging/diagnostic-log-internal.js", () => ({
  attachDiagnosticLogSemantics: loggingMocks.attachDiagnosticLogSemantics,
  attachDiagnosticLogSource: loggingMocks.attachDiagnosticLogSource,
  captureDiagnosticLogSource: loggingMocks.captureDiagnosticLogSource,
  hasDiagnosticLogSemantics: loggingMocks.hasDiagnosticLogSemantics,
  readAttachedDiagnosticLogSource: loggingMocks.readAttachedDiagnosticLogSource,
}));

let createRuntimeLogging: typeof import("./runtime-logging.js").createRuntimeLogging;

beforeEach(async () => {
  vi.clearAllMocks();
  loggingMocks.captureDiagnosticLogSource.mockReturnValue(loggingMocks.diagnosticSource);
  loggingMocks.getChildLogger.mockReturnValue(loggingMocks.childLogger);
  loggingMocks.isFileLogLevelEnabled.mockReturnValue(true);
  ({ createRuntimeLogging } = await import("./runtime-logging.js"));
});

describe("createRuntimeLogging", () => {
  it("forwards structured metadata to child loggers", () => {
    loggingMocks.captureDiagnosticLogSource.mockReturnValue(undefined);
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ plugin: "discord" }, { level: "warn" });
    const meta = {
      errorName: "Error",
      errorCauseName: "TypeError",
    };

    logger.debug?.("debug details", meta);
    logger.info("info details", meta);
    logger.warn("warn details", meta);
    logger.error("error details", meta);

    expect(loggingMocks.getChildLogger).toHaveBeenCalledWith(
      { plugin: "discord" },
      { level: "warn" },
    );
    expect(loggingMocks.childLogger.debug).toHaveBeenCalledWith(meta, "debug details");
    expect(loggingMocks.childLogger.info).toHaveBeenCalledWith(meta, "info details");
    expect(loggingMocks.childLogger.warn).toHaveBeenCalledWith(meta, "warn details");
    expect(loggingMocks.childLogger.error).toHaveBeenCalledWith(meta, "error details");
  });

  it("attaches plugin call-site source metadata before forwarding logs", () => {
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ plugin: "discord" });
    const meta = { status: "skipped" };

    logger.warn("plugin warning", meta);

    expect(loggingMocks.captureDiagnosticLogSource).toHaveBeenCalledWith({
      ignoredMethods: ["emit", "writeRuntimeLog", "debug", "info", "warn", "error"],
      ignoredPathSuffixes: [
        "src/plugins/runtime/runtime-logging.ts",
        "dist/plugins/runtime/runtime-logging.js",
      ],
    });
    expect(loggingMocks.attachDiagnosticLogSource).toHaveBeenCalledWith(
      meta,
      loggingMocks.diagnosticSource,
    );
    expect(loggingMocks.childLogger.warn).toHaveBeenCalledWith(
      {
        status: "skipped",
        __diagnosticSource: loggingMocks.diagnosticSource,
      },
      "plugin warning",
    );
  });

  it("attaches explicit plugin log semantics before forwarding logs", () => {
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ plugin: "discord" });
    const meta = { status: "skipped" };
    const semantics = {
      event: "plugins.discord.monitor.skipped",
      category: "plugins.discord.monitor",
      outcome: "warning" as const,
      reason: "not_ready",
    };

    logger.warn("plugin warning", meta, semantics);

    expect(loggingMocks.attachDiagnosticLogSource).toHaveBeenCalledWith(
      meta,
      loggingMocks.diagnosticSource,
    );
    expect(loggingMocks.attachDiagnosticLogSemantics).toHaveBeenCalledWith(
      {
        status: "skipped",
        __diagnosticSource: loggingMocks.diagnosticSource,
      },
      semantics,
    );
    expect(loggingMocks.childLogger.warn).toHaveBeenCalledWith(
      {
        status: "skipped",
        __diagnosticSource: loggingMocks.diagnosticSource,
        __diagnosticSemantics: semantics,
      },
      "plugin warning",
    );
  });

  it("skips runtime facade methods when bundled paths hide the source file", () => {
    const bundledPluginSource = {
      filePath: "dist/extensions/discord/src/monitor.js",
      functionName: "handleMessage",
      line: 32,
    };
    loggingMocks.captureDiagnosticLogSource.mockImplementationOnce((options) => {
      const ignoredMethods = new Set([
        "captureDiagnosticLogSource",
        "parseDiagnosticStackFrame",
        ...(options?.ignoredMethods ?? []),
      ]);
      const stackFrames = [
        {
          method: "captureDiagnosticLogSource",
          source: {
            filePath: "dist/plugins/runtime/index.js",
            functionName: "captureDiagnosticLogSource",
            line: 12,
          },
        },
        {
          method: "writeRuntimeLog",
          source: {
            filePath: "dist/plugins/runtime/index.js",
            functionName: "writeRuntimeLog",
            line: 16,
          },
        },
        {
          method: "warn",
          source: {
            filePath: "dist/plugins/runtime/index.js",
            functionName: "warn",
            line: 42,
          },
        },
        { method: "handleMessage", source: bundledPluginSource },
      ];
      return stackFrames.find((frame) => !ignoredMethods.has(frame.method))?.source;
    });
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ plugin: "discord" });

    logger.warn("plugin warning");

    expect(loggingMocks.attachDiagnosticLogSource).toHaveBeenCalledWith({}, bundledPluginSource);
  });

  it("keeps source metadata when plugin logs do not include metadata", () => {
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ plugin: "discord" });

    logger.info("plugin info");

    expect(loggingMocks.attachDiagnosticLogSource).toHaveBeenCalledWith(
      {},
      loggingMocks.diagnosticSource,
    );
    expect(loggingMocks.childLogger.info).toHaveBeenCalledWith(
      {
        __diagnosticSource: loggingMocks.diagnosticSource,
      },
      "plugin info",
    );
  });

  it("resolves the child logger per call so a runtime log-level change takes effect", () => {
    loggingMocks.captureDiagnosticLogSource.mockReturnValue(undefined);
    const logging = createRuntimeLogging();
    // Mirror a long-lived channel monitor: capture the logger once, log later.
    const logger = logging.getChildLogger({ module: "mattermost" });

    // Level is below debug when the monitor starts: the write is dropped.
    loggingMocks.isFileLogLevelEnabled.mockReturnValue(false);
    logger.debug?.("dropped before debug enabled");
    expect(loggingMocks.childLogger.debug).not.toHaveBeenCalled();
    expect(loggingMocks.getChildLogger).not.toHaveBeenCalled();

    // Log level raised to debug on the running gateway: the same captured logger
    // must now write, because it re-resolves the child logger per call.
    loggingMocks.isFileLogLevelEnabled.mockReturnValue(true);
    logger.debug?.("written after debug enabled");
    expect(loggingMocks.getChildLogger).toHaveBeenCalledWith({ module: "mattermost" }, undefined);
    expect(loggingMocks.childLogger.debug).toHaveBeenCalledWith("written after debug enabled");
  });

  it("pre-gates on the current file level when no override is set", () => {
    loggingMocks.captureDiagnosticLogSource.mockReturnValue(undefined);
    loggingMocks.isFileLogLevelEnabled.mockImplementation((level: string) => level !== "debug");
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ module: "mattermost" });

    logger.debug?.("debug suppressed at info");
    logger.info("info written at info");

    expect(loggingMocks.childLogger.debug).not.toHaveBeenCalled();
    expect(loggingMocks.childLogger.info).toHaveBeenCalledWith("info written at info");
  });
});
