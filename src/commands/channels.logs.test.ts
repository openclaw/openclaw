import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(() => ({
    plugins: [{ id: "vendor-external-chat", channels: ["external-chat"] }],
  })),
}));

vi.mock("../plugins/plugin-registry.js", () => pluginRegistryMocks);

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => {
    throw new Error("channels logs must not load channel plugins");
  }),
}));

import { channelsLogsCommand } from "./channels/logs.js";

const runtime = createTestRuntime();
function logLine(context: string, message: string, field: "module" | "plugin" = "module") {
  return `${JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: message,
    _meta: { logLevelName: "INFO", name: JSON.stringify({ [field]: context }) },
  })}\n`;
}

function readJsonPayload() {
  return JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
    channel: string;
    truncated: boolean;
    lines: Array<{ message: string; raw: string }>;
  };
}

describe("channelsLogsCommand", () => {
  let tempDir: string;
  let logPath: string;
  const writeLogs = (...lines: string[]) => fs.writeFile(logPath, lines.join(""));
  const messages = () => readJsonPayload().lines.map((line) => line.message);
  const output = () => runtime.log.mock.calls.flat().join("\n");
  const run = (opts: Parameters<typeof channelsLogsCommand>[0]) =>
    channelsLogsCommand(opts, runtime);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channels-logs-"));
    logPath = path.join(tempDir, "openclaw.log");
    setLoggerOverride({ file: logPath });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    resetSecretRedactionRegistryForTest();
    setLoggerOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters external plugin channel logs from the persisted manifest registry", async () => {
    await writeLogs(
      logLine("vendor-external-chat", "external sent", "plugin"),
      logLine("vendor-external-chat-shadow", "shadow sent", "plugin"),
      logLine("gateway/channels/slack/send", "slack sent"),
    );

    await run({ channel: "external-chat", json: true });

    expect(pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
      includeDisabled: true,
      env: process.env,
    });
    expect(readJsonPayload().channel).toBe("external-chat");
    expect(messages()).toEqual(["external sent"]);
  });

  it("matches nested channel module boundaries and redacts secrets", async () => {
    const fixtureCredential = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(fixtureCredential);
    await writeLogs(
      logLine("channels/discord-archive/send", "shadow"),
      logLine("channels/discord/send", `match opaque=${fixtureCredential}`),
    );

    await run({ channel: "discord", json: true });

    expect(messages()).toEqual(["match opaque=opaque…7890"]);
    expect(JSON.stringify(readJsonPayload())).not.toContain(fixtureCredential);

    runtime.log.mockClear();
    await run({ channel: "discord" });

    expect(output()).toContain("2026-04-25T12:00:00.000Z info match");
    expect(output()).toContain("opaque=opaque…7890");
    expect(output()).not.toContain(fixtureCredential);
    expect(output()).not.toContain("shadow");
  });

  it("rejects an unknown explicit channel without widening output", async () => {
    await writeLogs(logLine("gateway/channels/slack/send", "unrelated message"));

    const error = await run({ channel: "slakc", json: true }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Unknown channel "slakc". Valid channels: all,');
    expect((error as Error).message).toContain("external-chat");
    expect((error as Error).message).toContain("slack");
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each([
    { lines: undefined, count: 200 },
    { lines: 2, count: 2 },
  ])("preserves ordering with line limit $lines", async ({ lines, count }) => {
    const expected = Array.from({ length: 205 }, (_, index) => `message-${index}`);
    await writeLogs(
      ...expected.map((message, index) =>
        logLine(`gateway/channels/${index % 2 ? "external-chat" : "slack"}/send`, message),
      ),
    );

    await run({ channel: lines === undefined ? undefined : "all", lines, json: true });

    expect(readJsonPayload().channel).toBe("all");
    expect(messages()).toEqual(expected.slice(-count));
  });

  it("finds sparse channel records beyond the shared 5000-line cap", async () => {
    const filler = logLine("gateway/health", "ok");
    await writeLogs(
      logLine("gateway/channels/slack/send", "first match"),
      ...Array.from({ length: 5000 }, () => filler),
      logLine("gateway/channels/slack/send", "second match"),
    );

    await run({ channel: "slack", lines: 2000, json: true });

    expect(messages()).toEqual(["first match", "second match"]);
  });

  it("reports when the byte window omits all matching channel records", async () => {
    const omitted = logLine("gateway/channels/slack/send", "omitted");
    const filler = logLine("gateway/health", "x".repeat(1000));
    await writeLogs(omitted, filler.repeat(1100));

    await run({ channel: "slack", json: true });
    expect(readJsonPayload()).toMatchObject({ truncated: true, lines: [] });

    runtime.log.mockClear();
    await run({ channel: "slack" });
    expect(output()).toContain("Log tail truncated; earlier entries were omitted.");
  });
});
