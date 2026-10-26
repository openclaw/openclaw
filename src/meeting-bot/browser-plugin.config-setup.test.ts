import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";

const { zoomMeetingsPlugin: plugin } = await loadBrowserMeetingPlugins();
const command = "zoommeetings.chrome";
const commands = {
  audioInputCommand: ["custom-input", "--read"],
  audioOutputCommand: ["custom-output", "--write"],
  bargeInInputCommand: ["custom-barge-in"],
};
const audio = {
  audioBackend: "auto",
  audioBufferBytes: 4_096,
  audioFormat: "pcm16-24khz",
} as const;
const node = {
  caps: ["browser"],
  commands: ["browser.proxy", command],
  connected: true,
  displayName: "Zoom-node",
  nodeId: "node-1",
};

afterEach(() => vi.restoreAllMocks());

describe("shared browser meeting configuration and setup", () => {
  const resolveConfig = plugin.config.resolveConfig;
  let runtime: ReturnType<typeof createTestPluginApi>["runtime"];
  beforeEach(() => {
    runtime = createTestPluginApi().runtime;
    runtime.nodes = {
      invoke: vi.fn(async () => ({ ok: true })),
      openDuplex: vi.fn(),
      list: vi.fn(async () => ({ nodes: [node] })),
    };
  });
  function setup(
    options: { mode: "agent" | "bidi" | "transcribe"; transport?: "chrome" | "chrome-node" },
    chrome = {},
  ) {
    return plugin.setupStatus({
      config: resolveConfig({ chrome, chromeNode: { node: "Zoom-node" } }),
      fullConfig: {},
      runtime,
      options: { transport: "chrome-node", ...options },
    });
  }

  it.each<[string, string, string[], string[]]>([
    ["blackhole-2ch", "pcm16-24khz", ["sox", "2048"], ["BlackHole 2ch"]],
    ["blackhole-2ch", "g711-ulaw-8khz", ["BlackHole 2ch", "mu-law"], ["BlackHole 2ch"]],
    ["pipewire-pulse", "pcm16-24khz", ["parec", "--latency-msec=43"], ["pacat"]],
    ["pipewire-pulse", "g711-ulaw-8khz", ["parec", "--format=ulaw"], ["pacat"]],
  ])("builds %s command pairs for %s", (audioBackend, audioFormat, input, output) => {
    const config = resolveConfig({
      chrome: { audioBackend, audioFormat, audioBufferBytes: 2_048 },
    });
    expect(config.chrome.audioBackend).toBe(audioBackend);
    expect(config.chrome.audioInputCommand).toEqual(expect.arrayContaining(input));
    expect(config.chrome.audioOutputCommand).toEqual(expect.arrayContaining(output));
  });

  it("resolves explicit overrides", () => {
    const selected = {
      defaultMode: "bidi",
      chrome: commands,
      chromeNode: { node: "mac-node" },
      realtime: {
        voiceProvider: "google",
        model: "voice-model",
        providers: { google: { apiKey: "ref" } },
      },
    };
    expect(resolveConfig(selected)).toMatchObject({
      ...selected,
      chrome: {
        ...commands,
        audioInputCommandOverride: commands.audioInputCommand,
        audioOutputCommandOverride: commands.audioOutputCommand,
      },
    });
  });

  const readyMessage = "Remote virtual audio backend and command-pair prerequisites are ready";
  const missingMessage = "SoX audio command not found on the node.";
  it.each([
    ["agent", {}, true, readyMessage],
    ["agent", commands, true, readyMessage],
    ["bidi", {}, false, missingMessage],
    ["transcribe", {}, true, "Zoom live-caption capture is enabled and ready"],
  ] as const)("checks remote %s setup with %j", async (mode, overrides, ok, message) => {
    if (!ok) {
      vi.mocked(runtime.nodes.invoke).mockRejectedValue(new Error(missingMessage));
    }
    const status = await setup({ mode }, overrides);
    expect(status.ok).toBe(ok);
    const id = mode === "transcribe" ? "captions" : "chrome-node-audio-prerequisites";
    expect(status.checks).toContainEqual({ id, message, ok });
    if (mode === "transcribe") {
      expect(runtime.nodes.invoke).not.toHaveBeenCalled();
    } else {
      expect(runtime.nodes.invoke).toHaveBeenCalledWith({
        command,
        nodeId: "node-1",
        params: { action: "setup", ...audio, ...overrides },
        timeoutMs: 12_000,
      });
    }
  });

  it("stops local audio probing on an unsupported platform", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    runtime.system = { ...runtime.system, runCommandWithTimeout: vi.fn() };
    const status = await setup({ mode: "agent", transport: "chrome" });
    expect(status.ok).toBe(false);
    expect(status.checks).toContainEqual({
      id: "chrome-local-audio-device",
      message: expect.stringContaining("unsupported on win32"),
      ok: false,
    });
    expect(status.checks.some((check) => check.id === "chrome-local-audio-commands")).toBe(false);
    expect(runtime.system.runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it.each(["setup", "start"] as const)(
    "forwards only trusted %s audio configuration",
    async (action) => {
      const configured =
        action === "setup" ? commands : { bargeInInputCommand: ["trusted-barge-in"] };
      const route =
        action === "setup"
          ? {}
          : {
              url: "https://us02web.zoom.us/j/123456789",
              mode: "bidi",
              launch: true,
              browserProfile: undefined,
              joinTimeoutMs: 30_000,
            };
      const invokeNode = vi.fn(async () => ({ ok: true as const }));
      await plugin.createNodePolicy(resolveConfig({ chrome: configured })).handle({
        command,
        config: {},
        invokeNode,
        nodeId: "node-1",
        params: {
          action,
          ...route,
          audioBackend: "blackhole-2ch",
          audioBufferBytes: 1,
          audioFormat: "g711-ulaw-8khz",
          audioInputCommand: ["caller-capture"],
          audioOutputCommand: ["caller-playback"],
        },
      });
      expect(invokeNode).toHaveBeenCalledWith({
        params: { action, ...audio, ...configured, ...route },
      });
    },
  );
});
