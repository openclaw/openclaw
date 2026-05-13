import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  listPluginContributionIds: vi.fn(() => ["external-chat"]),
}));

const gatewayCallMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("gateway unavailable");
  }),
);

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayCallMock,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
  listPluginContributionIds: pluginRegistryMocks.listPluginContributionIds,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(() => {
    throw new Error("channels logs must not load channel plugins");
  }),
}));

import { channelsLogsCommand } from "./channels/logs.js";

const runtime = createTestRuntime();

function logLine(params: { module?: string; subsystem?: string; message: string }) {
  const name = params.subsystem ? { subsystem: params.subsystem } : { module: params.module };
  return JSON.stringify({
    time: "2026-04-25T12:00:00.000Z",
    0: params.message,
    _meta: {
      logLevelName: "INFO",
      name: JSON.stringify(name),
    },
  });
}

function readJsonPayload() {
  return JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
    file: string;
    channel: string;
    lines: Array<{ message: string }>;
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
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockClear();
    pluginRegistryMocks.listPluginContributionIds.mockClear();
    gatewayCallMock.mockReset();
    gatewayCallMock.mockRejectedValue(new Error("gateway unavailable"));
  });

  afterEach(async () => {
    setLoggerOverride(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("filters external plugin channel logs from the persisted manifest registry", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ module: "gateway/channels/external-chat/send", message: "external sent" }),
        logLine({ module: "gateway/channels/slack/send", message: "slack sent" }),
      ].join("\n"),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    expect(pluginRegistryMocks.loadPluginRegistrySnapshot).toHaveBeenCalledOnce();
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledOnce();
    const [contributionOptions] = pluginRegistryMocks.listPluginContributionIds.mock
      .calls[0] as unknown as [{ contribution?: string; includeDisabled?: boolean }];
    expect(contributionOptions?.contribution).toBe("channels");
    expect(contributionOptions?.includeDisabled).toBe(true);
    const payload = readJsonPayload();
    expect(payload.channel).toBe("external-chat");
    expect(payload.lines.map((line) => line.message)).toEqual(["external sent"]);
  });

  it("matches gateway channel subsystem loggers", async () => {
    await fs.writeFile(
      logPath,
      [
        logLine({ subsystem: "channels/telegram", message: "telegram started" }),
        logLine({ subsystem: "channels/slack", message: "slack started" }),
      ].join("\n"),
    );

    await channelsLogsCommand({ channel: "telegram", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.channel).toBe("telegram");
    expect(payload.lines.map((line) => line.message)).toEqual(["telegram started"]);
  });

  it("reads channel logs from gateway logs.tail when available", async () => {
    gatewayCallMock.mockResolvedValue({
      file: "/gateway/openclaw.log",
      lines: [
        logLine({ subsystem: "channels/telegram", message: "telegram gateway log" }),
        logLine({ subsystem: "channels/slack", message: "slack gateway log" }),
      ],
    });

    await channelsLogsCommand({ channel: "telegram", json: true }, runtime);

    expect(gatewayCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "logs.tail",
        params: expect.objectContaining({ limit: 800, maxBytes: 1_000_000 }),
      }),
    );
    const payload = readJsonPayload();
    expect(payload.file).toBe("/gateway/openclaw.log");
    expect(payload.lines.map((line) => line.message)).toEqual(["telegram gateway log"]);
  });

  it("falls back to the latest rolling log when the configured rolling file is missing", async () => {
    const configuredFile = path.join(tempDir, "openclaw-2026-04-26.log");
    const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
    const staleFile = path.join(tempDir, "openclaw-2026-04-24.log");
    setLoggerOverride({ file: configuredFile });
    await fs.writeFile(
      fallbackFile,
      [
        logLine({ module: "gateway/channels/slack/send", message: "slack fallback" }),
        logLine({ module: "gateway/channels/external-chat/send", message: "fallback sent" }),
      ].join("\n"),
    );
    await fs.writeFile(
      staleFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "stale sent" }),
    );
    await fs.utimes(
      staleFile,
      new Date("2026-04-24T12:00:00.000Z"),
      new Date("2026-04-24T12:00:00.000Z"),
    );
    await fs.utimes(
      fallbackFile,
      new Date("2026-04-25T12:00:00.000Z"),
      new Date("2026-04-25T12:00:00.000Z"),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(fallbackFile);
    expect(payload.lines.map((line) => line.message)).toEqual(["fallback sent"]);
  });

  it("prefers the configured rolling log when it exists", async () => {
    const configuredFile = path.join(tempDir, "openclaw-2026-04-26.log");
    const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
    setLoggerOverride({ file: configuredFile });
    await fs.writeFile(
      fallbackFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "fallback sent" }),
    );
    await fs.writeFile(
      configuredFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "current sent" }),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(configuredFile);
    expect(payload.lines.map((line) => line.message)).toEqual(["current sent"]);
  });

  it("does not fall back to rolling logs for a missing custom log file", async () => {
    const configuredFile = path.join(tempDir, "custom-channel.log");
    const fallbackFile = path.join(tempDir, "openclaw-2026-04-25.log");
    setLoggerOverride({ file: configuredFile });
    await fs.writeFile(
      fallbackFile,
      logLine({ module: "gateway/channels/external-chat/send", message: "fallback sent" }),
    );

    await channelsLogsCommand({ channel: "external-chat", json: true }, runtime);

    const payload = readJsonPayload();
    expect(payload.file).toBe(configuredFile);
    expect(payload.lines).toStrictEqual([]);
  });
});
