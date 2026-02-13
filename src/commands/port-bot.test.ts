import { afterEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({}));
const detectLegacyStateMigrations = vi.fn();
const runLegacyStateMigrations = vi.fn();
const promptYesNo = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfig(),
}));

vi.mock("./doctor-state-migrations.js", () => ({
  detectLegacyStateMigrations: (params: unknown) => detectLegacyStateMigrations(params),
  runLegacyStateMigrations: (params: unknown) => runLegacyStateMigrations(params),
}));

vi.mock("../cli/prompt.js", () => ({
  promptYesNo: (question: string, defaultYes?: boolean) => promptYesNo(question, defaultYes),
}));

function makeRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    runtime: {
      log: (message: string) => logs.push(message),
      error: (message: string) => errors.push(message),
      exit: (code: number) => {
        throw new Error(`__exit__:${code}`);
      },
    },
  };
}

describe("port-bot command", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports when no legacy state is found", async () => {
    detectLegacyStateMigrations.mockResolvedValueOnce({
      preview: [],
    });

    const { runtime, logs } = makeRuntime();
    const { portBotCommand } = await import("./port-bot.js");
    await portBotCommand(runtime);

    expect(runLegacyStateMigrations).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("No legacy bot state found to migrate.");
  });

  it("prints migration plan in dry-run mode", async () => {
    detectLegacyStateMigrations.mockResolvedValueOnce({
      preview: ["- Sessions: /old → /new"],
    });

    const { runtime, logs } = makeRuntime();
    const { portBotCommand } = await import("./port-bot.js");
    await portBotCommand(runtime, { dryRun: true });

    expect(runLegacyStateMigrations).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Legacy bot state detected:");
    expect(logs.join("\n")).toContain("Dry run only.");
  });

  it("runs migration when --yes is provided", async () => {
    detectLegacyStateMigrations.mockResolvedValueOnce({
      preview: ["- Sessions: /old → /new"],
    });
    runLegacyStateMigrations.mockResolvedValueOnce({
      changes: ["Moved sessions"],
      warnings: ["Left backup dir"],
    });

    const { runtime, logs, errors } = makeRuntime();
    const { portBotCommand } = await import("./port-bot.js");
    await portBotCommand(runtime, { yes: true });

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Migration changes:");
    expect(logs.join("\n")).toContain("Moved sessions");
    expect(errors.join("\n")).toContain("Migration warnings:");
    expect(errors.join("\n")).toContain("Left backup dir");
  });

  it("requires --yes in non-interactive mode", async () => {
    detectLegacyStateMigrations.mockResolvedValueOnce({
      preview: ["- Sessions: /old → /new"],
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    try {
      const { runtime, errors } = makeRuntime();
      const { portBotCommand } = await import("./port-bot.js");
      await expect(portBotCommand(runtime)).rejects.toThrow("__exit__:1");
      expect(runLegacyStateMigrations).not.toHaveBeenCalled();
      expect(errors.join("\n")).toContain("Non-interactive migration requires --yes.");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", originalDescriptor);
      } else {
        delete (process.stdin as Record<string, unknown>).isTTY;
      }
    }
  });
});
