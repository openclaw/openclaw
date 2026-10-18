// Channels logs tests cover gateway log path resolution and channel log tailing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => {
  const plugins = [{ id: "vendor-external-chat", channels: ["external-chat"] }];
  return {
    loadPluginManifestRegistryForPluginRegistry: vi.fn(() => ({ diagnostics: [], plugins })),
  };
});

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => {
    throw new Error("channels logs must not load channel plugins");
  }),
}));

import { channelsLogsCommand } from "./channels/logs.js";

const runtime = createTestRuntime();
function logLine(params: {
  subsystem?: string;
  module?: string;
  plugin?: string;
  message: string;
}) {
  return `${JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: params.message,
    _meta: {
      logLevelName: "INFO",
      name: JSON.stringify({
        ...(params.subsystem ? { subsystem: params.subsystem } : {}),
        ...(params.module ? { module: params.module } : {}),
        ...(params.plugin ? { plugin: params.plugin } : {}),
      }),
    },
  })}\n`;
}

function readJsonPayload() {
  return JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
    file: string;
    channel: string;
    truncated: boolean;
    lines: Array<{ message: string; raw: string }>;
  };
}

describe("channelsLogsCommand", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channels-logs-"));
    logPath = path.join(tempDir, "openclaw.log");
    setLoggerOverride({ file: logPath });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSecretRedactionRegistryForTest();
    setLoggerOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters external plugin channel logs from the persisted manifest registry", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ plugin: "vendor-external-chat", message: "external sent" }),
        logLine({ plugin: "vendor-external-chat-shadow", message: "shadow sent" }),
        logLine({ module: "gateway/channels/slack/send", message: "slack sent" }),
      ].join(""),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    expect(pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
      includeDisabled: true,
      env: process.env,
    });
    const payload = readJsonPayload();
    expect(payload.channel).toBe("external-chat");
    expect(payload.lines.map((line) => line.message)).toEqual(["external sent"]);
  });

  it.each([
    {
      label: "nested channel runtime module",
      channel: "discord",
      shadow: { module: "channels/discord-archive/send" },
      match: { module: "channels/discord/send" },
    },
  ])("matches channel boundaries and excludes a shadow $label", async (fixture) => {
    const fixtureCredential = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(fixtureCredential);
    await fs.writeFile(
      logPath,
      [
        logLine({ ...fixture.shadow, message: "shadow" }),
        logLine({ ...fixture.match, message: `match opaque=${fixtureCredential}` }),
      ].join(""),
    );

    await channelsLogsCommand({ channel: fixture.channel, json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.lines.map((line) => line.message)).toEqual(["match opaque=opaque…7890"]);
    expect(JSON.stringify(payload)).not.toContain(fixtureCredential);

    runtime.log.mockClear();
    await channelsLogsCommand({ channel: fixture.channel }, runtime);

    const output = runtime.log.mock.calls.flat().join("\n");
    expect(output).toContain("2026-04-25T12:00:00.000Z info match");
    expect(output).toContain("opaque=opaque…7890");
    expect(output).not.toContain(fixtureCredential);
    expect(output).not.toContain("shadow");
  });

  it("rejects an unknown explicit channel without widening output", async () => {
    await fs.writeFile(
      logPath,
      logLine({ module: "gateway/channels/slack/send", message: "unrelated message" }),
    );

    const error = await channelsLogsCommand({ channel: "slakc", json: true }, runtime).catch(
      (cause: unknown) => cause,
    );
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
    const messages = Array.from({ length: 205 }, (_, index) => `message-${index}`);
    await fs.writeFile(
      logPath,
      messages
        .map((message, index) =>
          logLine({
            module: `gateway/channels/${index % 2 ? "external-chat" : "slack"}/send`,
            message,
          }),
        )
        .join(""),
    );

    await channelsLogsCommand(
      { channel: lines === undefined ? undefined : "all", lines, json: true },
      runtime,
    );

    const payload = readJsonPayload();
    expect(payload.channel).toBe("all");
    expect(payload.lines.map((line) => line.message)).toEqual(messages.slice(-count));
  });

  it("finds sparse channel records beyond the shared 5000-line cap", async () => {
    const filler = logLine({ module: "gateway/health", message: "ok" });
    const lines = [
      logLine({ module: "gateway/channels/slack/send", message: "first match" }),
      ...Array.from({ length: 5000 }, () => filler),
      logLine({ module: "gateway/channels/slack/send", message: "second match" }),
    ];
    await fs.writeFile(logPath, lines.join(""));

    await channelsLogsCommand({ channel: "slack", lines: 2000, json: true }, runtime);

    expect(readJsonPayload().lines.map((line) => line.message)).toEqual([
      "first match",
      "second match",
    ]);
  });

  it("reports when the byte window omits all matching channel records", async () => {
    const omitted = logLine({ module: "gateway/channels/slack/send", message: "omitted" });
    const filler = logLine({ module: "gateway/health", message: "x".repeat(1000) });
    await fs.writeFile(logPath, `${omitted}${filler.repeat(1100)}`);

    await channelsLogsCommand({ channel: "slack", json: true }, runtime);
    expect(readJsonPayload()).toMatchObject({ truncated: true, lines: [] });

    runtime.log.mockClear();
    await channelsLogsCommand({ channel: "slack" }, runtime);
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "Log tail truncated; earlier entries were omitted.",
    );
  });
});
