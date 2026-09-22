import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { convertPcmToMulaw8k } from "../talk/audio-codec.js";
import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type { MeetingChromeTransportConfig } from "./chrome-transport-types.js";
import { createMeetingPluginConfigSchema } from "./plugin-config.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import { type MeetingRealtimeEngineConfig, startMeetingRealtimeEngine } from "./realtime-engine.js";
import { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";
import { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";

const browserMocks = vi.hoisted(() => ({
  callNode: vi.fn(),
  leave: vi.fn(),
  open: vi.fn(),
  resolveLocal: vi.fn(),
  resolveNode: vi.fn(),
}));

vi.mock("./browser-node.js", () => ({
  callMeetingBrowserProxyOnNode: browserMocks.callNode,
  resolveMeetingBrowserNode: browserMocks.resolveNode,
}));
vi.mock("./browser-controller.js", () => ({
  openMeetingWithBrowser: browserMocks.open,
  recoverMeetingBrowserTab: vi.fn(),
}));
vi.mock("./browser-request.js", () => ({
  resolveLocalMeetingBrowserRequest: browserMocks.resolveLocal,
}));
vi.mock("./browser-session-control.js", () => ({
  leaveMeetingWithBrowser: browserMocks.leave,
  readMeetingTranscriptWithBrowser: vi.fn(),
}));

import { createMeetingChromeTransport } from "./chrome-transport.js";
import type {
  MeetingPlatformAdapter,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type { MeetingBrowserHealth, MeetingTranscriptSnapshot } from "./session-types.js";

type TestMode = "agent" | "bidi" | "transcribe";
type TestConfig = MeetingRealtimeEngineConfig & {
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioBackend: "auto";
    audioBufferBytes: number;
    audioInputCommand: string[];
    audioOutputCommand: string[];
    autoJoin: boolean;
    bargeInCooldownMs: number;
    bargeInPeakThreshold: number;
    bargeInRmsThreshold: number;
    guestName: string;
    joinTimeoutMs: number;
    launch: boolean;
    reuseExistingTab: boolean;
    waitForInCallMs: number;
  };
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    toolPolicy: "none";
  };
};

const config = {
  chrome: {
    audioBackend: "auto",
    audioBufferBytes: 4_096,
    audioFormat: "pcm16-24khz",
    audioInputCommand: [],
    audioOutputCommand: [],
    autoJoin: true,
    bargeInCooldownMs: 0,
    bargeInPeakThreshold: 0,
    bargeInRmsThreshold: 0,
    guestName: "OpenClaw",
    joinTimeoutMs: 1_000,
    launch: true,
    reuseExistingTab: true,
    waitForInCallMs: 1_000,
  },
  chromeNode: {},
  realtime: {
    providers: {},
    strategy: "agent",
    toolPolicy: "none",
  },
} satisfies TestConfig;

const platform = {
  id: "test-meetings",
  displayName: "Test meetings",
  browserLabel: "Test meeting",
  logScope: "[test-meetings]",
  agentConsult: {
    surface: "a private test meeting",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    workingResponseLabel: "participant",
    extraSystemPrompt: "Test",
  },
  session: {
    idPrefix: "test_meeting",
    participantIdentity: () => "Test participant",
  },
  nodeCommandName: "testmeetings.chrome",
  nodeConfigPath: "plugins.entries.test-meetings.config.chromeNode.node",
  browser: {},
} as unknown as MeetingPlatformAdapter<
  { meetingSessionId: string; mode: TestMode; url: string },
  TestMode,
  MeetingBrowserHealth,
  MeetingTranscriptSnapshot
> &
  MeetingPlatformRuntimeMetadata;

const logger: RuntimeLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const cases = [
  { name: "Teams", preserveTrackedBrowserOnEngineFailure: false, expectedLeaves: 1 },
  { name: "Zoom", preserveTrackedBrowserOnEngineFailure: true, expectedLeaves: 0 },
] as const;

describe.each(cases)("$name Chrome transport parity", (testCase) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    browserMocks.resolveLocal.mockResolvedValue(vi.fn());
    browserMocks.resolveNode.mockResolvedValue("node-1");
    browserMocks.open.mockResolvedValue({
      launched: true,
      browser: { inCall: true },
      tab: { targetId: "tracked-tab", openedByPlugin: false },
    });
    browserMocks.leave.mockResolvedValue({ left: true, note: "Left meeting." });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the platform rollback ownership rule for tracked calls", async () => {
    const dispose = vi.fn(async () => {});
    const engine = {
      providerId: "openai",
      speak: vi.fn(),
      getHealth: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const startAgent = vi
      .fn(async () => engine)
      .mockRejectedValueOnce(new Error("realtime startup failed"));
    const createBindings = vi.fn(() => ({
      platform: { displayName: "Test", logScope: "[test]", sessionIdPrefix: "test" },
      consultAgent: vi.fn(),
      tools: [],
      handleToolCall: vi.fn(),
    }));
    const transport = createMeetingChromeTransport<
      TestConfig,
      TestMode,
      MeetingBrowserHealth,
      MeetingTranscriptSnapshot
    >({
      browserNodeAdapter: platform,
      isRealtimeRouteReady: () => true,
      isTalkBackMode: () => true,
      meetingLabel: `${testCase.name} meeting`,
      nodeCommandName: platform.nodeCommandName,
      platform,
      preserveTrackedBrowserOnEngineFailure: testCase.preserveTrackedBrowserOnEngineFailure,
      runtime: {
        createBindings: createBindings as unknown as typeof createMeetingRealtimeEngineBindings,
        createLocalAudioTransport: vi.fn(() => ({
          clearOutput: vi.fn(),
          dispose,
          onFatal: vi.fn(),
          startInput: vi.fn(),
          stop: vi.fn(),
          writeOutput: vi.fn(),
        })) as unknown as typeof createLocalMeetingRealtimeAudioTransport,
        createNodeAudioTransport:
          vi.fn() as unknown as typeof createNodeMeetingRealtimeAudioTransport,
        startAgentRealtimeEngine: startAgent,
        startRealtimeEngine: vi.fn() as unknown as typeof startMeetingRealtimeEngine,
      },
    });
    const runtime = {
      system: {
        runCommandWithTimeout: vi.fn(async () => ({
          code: 0,
          stderr: "",
          stdout: "BlackHole 2ch",
        })),
      },
    } as unknown as PluginRuntime;

    const launch = () =>
      transport.launchInChrome({
        config,
        fullConfig: { transcripts: { enabled: false } } as OpenClawConfig,
        logger,
        meetingSessionId: "session-1",
        mode: "agent" as const,
        runtime,
        trackedTargetId: "tracked-tab",
        url: "https://example.test/meeting",
      });
    await expect(launch()).rejects.toThrow("realtime startup failed");

    expect(dispose).toHaveBeenCalledOnce();
    expect(browserMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ captureCaptions: false, mode: "agent" }),
      }),
    );
    expect(browserMocks.leave).toHaveBeenCalledTimes(testCase.expectedLeaves);
    const bindingFailure = new Error("meeting binding failed");
    createBindings.mockImplementationOnce(() => {
      throw bindingFailure;
    });
    dispose.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(launch()).rejects.toBe(bindingFailure);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(browserMocks.leave).toHaveBeenCalledTimes(testCase.expectedLeaves * 2);
    const recovered = await launch();
    expect(recovered.audioBridge).toEqual({ type: "command-pair", ...engine });
    expect(recovered.audioBridge?.providerId).toBe("openai");
  });

  it("enables output generations when the node host advertises support", async () => {
    const nodeAudioTransport = {
      clearOutput: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
      onFatal: vi.fn(),
      startInput: vi.fn(),
      stop: vi.fn(async () => {}),
      writeOutput: vi.fn(async () => {}),
    };
    const createNodeAudioTransport = vi.fn(() => nodeAudioTransport);
    const transport = createMeetingChromeTransport<
      TestConfig,
      TestMode,
      MeetingBrowserHealth,
      MeetingTranscriptSnapshot
    >({
      browserNodeAdapter: platform,
      isRealtimeRouteReady: () => true,
      isTalkBackMode: () => true,
      meetingLabel: `${testCase.name} meeting`,
      nodeCommandName: platform.nodeCommandName,
      platform,
      preserveTrackedBrowserOnEngineFailure: testCase.preserveTrackedBrowserOnEngineFailure,
      runtime: {
        createBindings: vi.fn(() => ({
          platform: { displayName: "Test", logScope: "[test]", sessionIdPrefix: "test" },
          consultAgent: vi.fn(),
          tools: [],
          handleToolCall: vi.fn(),
        })) as unknown as typeof createMeetingRealtimeEngineBindings,
        createLocalAudioTransport:
          vi.fn() as unknown as typeof createLocalMeetingRealtimeAudioTransport,
        createNodeAudioTransport:
          createNodeAudioTransport as unknown as typeof createNodeMeetingRealtimeAudioTransport,
        startAgentRealtimeEngine: vi.fn(async () => ({
          providerId: "openai",
          speak: vi.fn(),
          getHealth: vi.fn(),
          stop: vi.fn(async () => {}),
        })) as unknown as typeof startMeetingAgentRealtimeEngine,
        startRealtimeEngine: vi.fn() as unknown as typeof startMeetingRealtimeEngine,
      },
    });
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params: { action: string } }) =>
          params.action === "start"
            ? {
                payload: {
                  audioBridge: { type: "node-command-pair", outputGeneration: true },
                  bridgeId: "bridge-1",
                  launched: true,
                },
              }
            : { payload: { ok: true } },
        ),
      },
    } as unknown as PluginRuntime;

    const result = await transport.launchOnNode({
      config,
      fullConfig: { transcripts: { enabled: false } } as OpenClawConfig,
      logger,
      meetingSessionId: "session-1",
      mode: "agent",
      runtime,
      url: "https://example.test/meeting",
    });

    expect(result.audioBridge?.type).toBe("node-command-pair");
    expect(result.audioBridge?.providerId).toBe("openai");
    expect(runtime.nodes.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          action: "setup",
          audioBackend: "auto",
          audioBufferBytes: 4_096,
          audioFormat: "pcm16-24khz",
        }),
      }),
    );
    const startCall = vi
      .mocked(runtime.nodes.invoke)
      .mock.calls.find(([call]) => (call.params as { action?: string }).action === "start")?.[0];
    expect(startCall?.params).not.toHaveProperty("audioInputCommand");
    expect(startCall?.params).not.toHaveProperty("audioOutputCommand");
    expect(
      Reflect.get(
        nodeAudioTransport,
        Symbol.for("openclaw.internal.meeting-node-output-generation.v1"),
      ),
    ).toBe(true);
  });
});

class InputContractProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

describe("Chrome configured audio input contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    browserMocks.resolveNode.mockResolvedValue("node-1");
    browserMocks.open.mockResolvedValue({
      launched: true,
      browser: { inCall: true },
      tab: { targetId: "audio-tab", openedByPlugin: false },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(
    (["local", "node"] as const).flatMap((host) =>
      (["agent", "bidi"] as const).flatMap((mode) =>
        (["default", "output-only", "custom-input"] as const).map((inputSource) => ({
          host,
          mode,
          inputSource,
        })),
      ),
    ),
  )(
    "delivers $inputSource audio through the $host $mode provider",
    async ({ host, mode, inputSource }) => {
      const customInput = inputSource === "custom-input";
      const normalized = createMeetingPluginConfigSchema({
        defaultRealtimeInstructions: "Test voice",
        resolveGatewayOperationTimeoutMs: () => 1000,
      }).resolveConfig({
        chrome: {
          ...(customInput ? { audioInputCommand: ["custom-capture"] } : {}),
          ...(inputSource === "output-only" ? { audioOutputCommand: ["custom-play"] } : {}),
        },
        realtime: { provider: "test", transcriptionProvider: "test", toolPolicy: "none" },
      });
      const nativeAudio = Buffer.alloc(960, 0x11);
      const browserAudio = Buffer.alloc(960, 0x33);
      const releaseAudio = createDeferredCore();
      const nodeStopped = createDeferredCore();
      let nodeDelivered = false;
      let browserDelivered = false;
      let inputProcess: InputContractProcess | undefined;
      const sendAudio = vi.fn();
      const callBrowser = vi.fn(async ({ body }: { body: { fn: string } }) => {
        const { action, captureId } = JSON.parse(body.fn) as { action: string; captureId: string };
        if (action === "pull" && !browserDelivered) {
          browserDelivered = true;
          await releaseAudio.promise;
          return {
            result: JSON.stringify({
              captureId,
              isolated: true,
              base64: browserAudio.toString("base64"),
            }),
          };
        }
        return {
          result: JSON.stringify({
            captureId,
            isolated: action !== "stop",
            closed: action === "stop",
            base64: "",
          }),
        };
      });
      browserMocks.resolveLocal.mockResolvedValue(callBrowser);
      browserMocks.callNode.mockImplementation(callBrowser);
      const runtime = createPluginRuntime();
      vi.spyOn(runtime.system, "runCommandWithTimeout").mockResolvedValue({
        stdout: "BlackHole 2ch",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
      const invoke = vi.spyOn(runtime.nodes, "invoke").mockImplementation(async ({ params }) => {
        const request = params as { action: string };
        if (request.action === "start") {
          return { bridgeId: "bridge-1", audioBridge: { type: "node-command-pair" } };
        }
        if (request.action === "pullAudio") {
          if (nodeDelivered) {
            await nodeStopped.promise;
            return { closed: true };
          }
          nodeDelivered = true;
          await releaseAudio.promise;
          return { base64: nativeAudio.toString("base64") };
        }
        if (request.action === "stop") {
          nodeStopped.resolve();
        }
        return { ok: true };
      });
      const transport = createMeetingChromeTransport<
        MeetingChromeTransportConfig,
        TestMode,
        MeetingBrowserHealth,
        MeetingTranscriptSnapshot
      >({
        browserNodeAdapter: platform,
        isRealtimeRouteReady: () => true,
        isTalkBackMode: () => true,
        meetingLabel: "Test meeting",
        nodeCommandName: platform.nodeCommandName,
        platform: {
          ...platform,
          browser: { ...platform.browser, buildAudioCaptureScript: JSON.stringify },
        },
        preserveTrackedBrowserOnEngineFailure: false,
        runtime: {
          createBindings: createMeetingRealtimeEngineBindings,
          createLocalAudioTransport: (params) =>
            createLocalMeetingRealtimeAudioTransport({
              ...params,
              spawn: (_command, _args, options) => {
                const child = new InputContractProcess();
                if (options.stdio[1] === "pipe") {
                  inputProcess = child;
                }
                return child;
              },
            }),
          createNodeAudioTransport: createNodeMeetingRealtimeAudioTransport,
          startAgentRealtimeEngine: (params) =>
            startMeetingAgentRealtimeEngine({
              ...params,
              providers: [
                {
                  id: "test",
                  label: "Test",
                  isConfigured: () => true,
                  createSession: () => ({
                    connect: async () => {},
                    close() {},
                    isConnected: () => true,
                    sendAudio,
                  }),
                },
              ],
            }),
          startRealtimeEngine: (params) =>
            startMeetingRealtimeEngine({
              ...params,
              providers: [
                {
                  id: "test",
                  label: "Test",
                  isConfigured: () => true,
                  createBridge: () => ({
                    connect: async () => {},
                    close() {},
                    isConnected: () => true,
                    sendAudio,
                    handleBargeIn() {},
                    setMediaTimestamp() {},
                    acknowledgeMark() {},
                    submitToolResult() {},
                  }),
                },
              ],
            }),
        },
      });
      const launch = host === "local" ? transport.launchInChrome : transport.launchOnNode;
      const result = await launch({
        config: normalized,
        fullConfig: {},
        logger,
        meetingSessionId: "input-session",
        mode,
        runtime,
        url: "https://example.test/meeting",
      });
      try {
        releaseAudio.resolve();
        inputProcess?.stdout.write(nativeAudio);
        const expected = customInput ? nativeAudio : browserAudio;
        await vi.waitFor(() =>
          expect(sendAudio).toHaveBeenCalledWith(
            mode === "agent" ? convertPcmToMulaw8k(expected, 24000) : expected,
          ),
        );
        if (customInput) {
          expect(callBrowser).not.toHaveBeenCalled();
        } else {
          expect(callBrowser).toHaveBeenCalled();
        }
        if (host === "node" && customInput) {
          expect(invoke).toHaveBeenCalledWith(
            expect.objectContaining({
              params: expect.objectContaining({
                action: "start",
                audioInputCommand: ["custom-capture"],
              }),
            }),
          );
        }
      } finally {
        releaseAudio.resolve();
        await result.audioBridge?.stop();
      }
    },
  );
});
