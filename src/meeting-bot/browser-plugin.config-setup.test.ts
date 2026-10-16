import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";

const { zoomMeetingsPlugin: plugin } = await loadBrowserMeetingPlugins();
const name = "Zoom";
const command = "zoommeetings.chrome";
const commands = {
  audioInputCommand: ["custom-input", "--read"],
  audioOutputCommand: ["custom-output", "--write"],
  bargeInInputCommand: ["custom-barge-in"],
};
const audio = { audioBackend: "auto", audioBufferBytes: 4_096, audioFormat: "pcm16-24khz" };

afterEach(() => vi.restoreAllMocks());

describe("shared browser meeting configuration and setup", () => {
  const resolveConfig = plugin.config.resolveConfig;
  function setup(
    options: { mode: "agent" | "bidi" | "transcribe"; transport?: "chrome" | "chrome-node" },
    chrome = {},
  ) {
    const runtime = createTestPluginApi().runtime;
    runtime.nodes = {
      invoke: vi.fn(async () => ({ ok: true })),
      openDuplex: vi.fn(),
      list: vi.fn(async () => ({
        nodes: [
          {
            caps: ["browser"],
            commands: ["browser.proxy", command],
            connected: true,
            displayName: `${name}-node`,
            nodeId: "node-1",
          },
        ],
      })),
    };
    const config = resolveConfig({ chrome, chromeNode: { node: `${name}-node` } });
    return {
      runtime,
      run: () =>
        plugin.setupStatus({
          config,
          fullConfig: {},
          runtime,
          options: { transport: "chrome-node", ...options },
        }),
    };
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

  it.each(["overrides", "timer bounds"])("resolves explicit %s", (kind) => {
    const realtime = {
      voiceProvider: "google",
      model: "voice-model",
      providers: { google: { apiKey: "ref" } },
    };
    if (kind === "overrides") {
      expect(
        resolveConfig({
          defaultMode: "bidi",
          chrome: commands,
          chromeNode: { node: "mac-node" },
          realtime,
        }),
      ).toMatchObject({
        defaultMode: "bidi",
        chrome: {
          ...commands,
          audioInputCommandOverride: commands.audioInputCommand,
          audioOutputCommandOverride: commands.audioOutputCommand,
        },
        chromeNode: { node: "mac-node" },
        realtime,
      });
    } else {
      const config = resolveConfig({
        chrome: { joinTimeoutMs: Number.MAX_VALUE, waitForInCallMs: Number.MAX_VALUE },
      });
      expect(config.chrome.joinTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(config.chrome.waitForInCallMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(plugin.config.resolveGatewayOperationTimeoutMs(config)).toBe(MAX_TIMER_TIMEOUT_MS);
    }
  });

  it.each([false, true])(
    "probes selected-node talk-back prerequisites with overrides=%s",
    async (overrides) => {
      const { runtime, run } = setup({ mode: "agent" }, overrides ? commands : {});
      const status = await run();
      expect(runtime.nodes.invoke).toHaveBeenCalledWith({
        command,
        nodeId: "node-1",
        params: { action: "setup", ...audio, ...(overrides ? commands : {}) },
        timeoutMs: 12_000,
      });
      expect(status.checks).toContainEqual({
        id: "chrome-node-audio-prerequisites",
        message: "Remote virtual audio backend and command-pair prerequisites are ready",
        ok: true,
      });
      expect(status.ok).toBe(true);
    },
  );

  it("reports observe-only captions without probing audio", async () => {
    const { runtime, run } = setup({ mode: "transcribe" });
    const status = await run();
    expect(status.checks).toContainEqual({
      id: "captions",
      message: `${name} live-caption capture is enabled and ready`,
      ok: true,
    });
    expect(runtime.nodes.invoke).not.toHaveBeenCalled();
  });

  it.each(["chrome-node", "chrome"] as const)(
    "reports unavailable audio prerequisites on %s",
    async (transport) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const { runtime, run } = setup({
        mode: transport === "chrome" ? "agent" : "bidi",
        transport,
      });
      vi.mocked(runtime.nodes.invoke).mockRejectedValue(
        new Error("SoX audio command not found on the node."),
      );
      runtime.system = { ...runtime.system, runCommandWithTimeout: vi.fn() };
      const status = await run();
      expect(status.ok).toBe(false);
      expect(status.checks).toContainEqual({
        id:
          transport === "chrome" ? "chrome-local-audio-device" : "chrome-node-audio-prerequisites",
        message:
          transport === "chrome"
            ? expect.stringContaining("unsupported on win32")
            : "SoX audio command not found on the node.",
        ok: false,
      });
      if (transport === "chrome") {
        expect(status.checks.some((check) => check.id === "chrome-local-audio-commands")).toBe(
          false,
        );
        expect(runtime.system.runCommandWithTimeout).not.toHaveBeenCalled();
      }
    },
  );

  it("replaces setup probe commands with trusted configured commands", async () => {
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    await plugin.createNodePolicy(resolveConfig({ chrome: commands })).handle({
      command,
      config: {},
      invokeNode,
      nodeId: "node-1",
      params: {
        action: "setup",
        audioInputCommand: ["untrusted-input"],
        audioOutputCommand: ["untrusted-output"],
      },
    });
    expect(invokeNode).toHaveBeenCalledWith({
      params: { action: "setup", ...audio, ...commands },
    });
  });
});
