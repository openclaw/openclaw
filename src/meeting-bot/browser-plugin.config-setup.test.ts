import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";

const { zoomMeetingsPlugin, teamsMeetingsPlugin, slackHuddlesPlugin } =
  await loadBrowserMeetingPlugins();

const plugins = [
  { name: "Zoom", plugin: zoomMeetingsPlugin, command: "zoommeetings.chrome" },
  { name: "Teams", plugin: teamsMeetingsPlugin, command: "teamsmeetings.chrome" },
  { name: "Slack", plugin: slackHuddlesPlugin, command: "slackhuddles.chrome" },
];
const commands = {
  audioInputCommand: ["custom-input", "--read"],
  audioOutputCommand: ["custom-output", "--write"],
  bargeInInputCommand: ["custom-barge-in"],
};
const audio = { audioBackend: "auto", audioBufferBytes: 4_096, audioFormat: "pcm16-24khz" };

afterEach(() => vi.restoreAllMocks());

describe.each(plugins)(
  "$name browser meeting configuration and setup",
  ({ name, plugin, command }) => {
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

    it("keeps sparse config defaults and legacy audio backend selection", () => {
      const config = resolveConfig({});
      expect(config.defaultMode).toBe("agent");
      expect(config.chrome).toMatchObject({
        ...audio,
        autoJoin: true,
        reuseExistingTab: true,
        waitForInCallMs: 60_000,
      });
      expect(config.chrome.audioInputCommandOverride).toBeUndefined();
      expect(config.chrome.audioOutputCommandOverride).toBeUndefined();
      expect(config.chromeNode.node).toBeUndefined();
      const legacy = resolveConfig({ chrome: { audioBackend: "blackhole-2ch" } });
      expect(legacy.chrome.audioBackend).toBe("blackhole-2ch");
      expect(legacy.chrome.audioInputCommand).toContain("BlackHole 2ch");
      expect(legacy.chrome.audioOutputCommand).toContain("BlackHole 2ch");
    });

    it.each<[string, string, string[], string[]]>([
      ["blackhole-2ch", "pcm16-24khz", ["sox", "2048"], ["BlackHole 2ch"]],
      ["blackhole-2ch", "g711-ulaw-8khz", ["BlackHole 2ch", "mu-law"], ["BlackHole 2ch"]],
      ["pipewire-pulse", "pcm16-24khz", ["parec", "--latency-msec=43"], ["pacat"]],
      ["pipewire-pulse", "g711-ulaw-8khz", ["parec", "--format=ulaw"], ["pacat"]],
    ])("builds %s command pairs for %s", (audioBackend, audioFormat, input, output) => {
      const config = resolveConfig({
        chrome: { audioBackend, audioFormat, audioBufferBytes: 2_048 },
      });
      expect(config.chrome.audioInputCommand).toEqual(expect.arrayContaining(input));
      expect(config.chrome.audioOutputCommand).toEqual(expect.arrayContaining(output));
    });

    it("preserves explicit command overrides and realtime passthrough", () => {
      const realtime = {
        voiceProvider: "google",
        model: "voice-model",
        providers: { google: { apiKey: "ref" } },
      };
      const config = resolveConfig({
        defaultMode: "bidi",
        chrome: commands,
        chromeNode: { node: "mac-node" },
        realtime,
      });
      expect(config).toMatchObject({
        defaultMode: "bidi",
        chrome: {
          ...commands,
          audioInputCommandOverride: commands.audioInputCommand,
          audioOutputCommandOverride: commands.audioOutputCommand,
        },
        chromeNode: { node: "mac-node" },
        realtime,
      });
    });

    it("caps timer values and gateway grace", () => {
      const config = resolveConfig({
        chrome: { joinTimeoutMs: Number.MAX_VALUE, waitForInCallMs: Number.MAX_VALUE },
      });
      expect(config.chrome.joinTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(config.chrome.waitForInCallMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(plugin.config.resolveGatewayOperationTimeoutMs(config)).toBe(MAX_TIMER_TIMEOUT_MS);
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
        message:
          name === "Slack"
            ? "Slack captions depend on the account preference to turn on captions by default when joining huddles"
            : `${name} live-caption capture is enabled and ready`,
        ok: true,
      });
      expect(runtime.nodes.invoke).not.toHaveBeenCalled();
    });

    it("fails setup when the remote prerequisite probe fails", async () => {
      const { runtime, run } = setup({ mode: "bidi" });
      vi.mocked(runtime.nodes.invoke).mockRejectedValue(
        new Error("SoX audio command not found on the node."),
      );
      const status = await run();
      expect(status.ok).toBe(false);
      expect(status.checks).toContainEqual({
        id: "chrome-node-audio-prerequisites",
        message: "SoX audio command not found on the node.",
        ok: false,
      });
    });

    it("returns structured diagnostics when local talk-back is unsupported", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const { runtime, run } = setup({ mode: "agent", transport: "chrome" });
      runtime.system = { ...runtime.system, runCommandWithTimeout: vi.fn() };
      const status = await run();
      expect(status.ok).toBe(false);
      expect(status.checks).toContainEqual({
        id: "chrome-local-audio-device",
        message: expect.stringContaining("unsupported on win32"),
        ok: false,
      });
      expect(status.checks.some((check) => check.id === "chrome-local-audio-commands")).toBe(false);
      expect(runtime.system.runCommandWithTimeout).not.toHaveBeenCalled();
    });

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
  },
);
