import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { convertPcmToMulaw8k } from "../talk/audio-codec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import type { MeetingChromeTransportConfig } from "./chrome-transport-types.js";
import { TEST_MEETING_PLATFORM_METADATA } from "./observation-provenance.test-support.js";
import { createMeetingPluginConfigSchema } from "./plugin-config.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import { startMeetingRealtimeEngine } from "./realtime-engine.js";
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
const configSchema = createMeetingPluginConfigSchema({
  defaultRealtimeInstructions: "Test voice",
  resolveGatewayOperationTimeoutMs: () => 1000,
});
const config = configSchema.resolveConfig({
  chrome: {
    guestName: "OpenClaw",
    joinTimeoutMs: 1_000,
    waitForInCallMs: 1_000,
  },
  realtime: { strategy: "agent", toolPolicy: "none" },
});

const platform = {
  ...TEST_MEETING_PLATFORM_METADATA,
  browserLabel: "Test meeting",
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

const createTransport = createMeetingChromeTransport<
  MeetingChromeTransportConfig,
  TestMode,
  MeetingBrowserHealth,
  MeetingTranscriptSnapshot
>;
const transportOptions = {
  browserNodeAdapter: platform,
  isRealtimeRouteReady: () => true,
  isTalkBackMode: () => true,
  meetingLabel: "Test meeting",
  nodeCommandName: platform.nodeCommandName,
  platform,
  preserveTrackedBrowserOnEngineFailure: false,
};
type TransportOptions = Parameters<typeof createTransport>[0];
function mockTransport(options: Partial<Omit<TransportOptions, "runtime">> = {}, node = false) {
  const engine = {
    providerId: "openai",
    speak: vi.fn(),
    getHealth: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createBindings = vi.fn(createMeetingRealtimeEngineBindings);
  const startAgent = vi.fn(async () => engine);
  const dispose = vi.fn(async () => {});
  const localAudio = {
    clearOutput: vi.fn(async () => {}),
    dispose,
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: vi.fn(async () => {}),
    writeOutput: vi.fn(async () => {}),
  };
  const createNodeAudioTransport = node
    ? vi.fn<typeof createNodeMeetingRealtimeAudioTransport>(() => localAudio)
    : vi.fn<typeof createNodeMeetingRealtimeAudioTransport>();
  const transport = createTransport({
    ...transportOptions,
    ...options,
    runtime: {
      createBindings,
      createLocalAudioTransport: node ? vi.fn() : vi.fn(() => localAudio),
      createNodeAudioTransport,
      startAgentRealtimeEngine: startAgent,
      startRealtimeEngine: vi.fn(),
    } as unknown as TransportOptions["runtime"],
  });
  return {
    transport,
    engine,
    createBindings,
    startAgent,
    dispose,
    nodeAudioTransport: localAudio,
    createNodeAudioTransport,
  };
}

const launchParams = {
  config,
  fullConfig: { transcripts: { enabled: false } },
  logger,
  meetingSessionId: "session-1",
  mode: "agent" as const,
  url: "https://example.test/meeting",
};
function openedTab(targetId = "tracked-tab", openedByPlugin = false) {
  browserMocks.open.mockResolvedValue({
    launched: true,
    browser: { inCall: true },
    tab: { targetId, openedByPlugin },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  browserMocks.resolveLocal.mockResolvedValue(vi.fn());
  browserMocks.resolveNode.mockResolvedValue("node-1");
  openedTab();
  browserMocks.leave.mockResolvedValue({ left: true, note: "Left meeting." });
});
afterEach(() => vi.restoreAllMocks());

const cases = [
  { name: "Teams", preserveTrackedBrowserOnEngineFailure: false, expectedLeaves: 1 },
  { name: "Zoom", preserveTrackedBrowserOnEngineFailure: true, expectedLeaves: 0 },
] as const;

describe("meeting Chrome transport", () => {
  it.each(cases)("preserves $name rollback ownership for tracked calls", async (testCase) => {
    const { transport, engine, createBindings, startAgent, dispose } = mockTransport({
      meetingLabel: `${testCase.name} meeting`,
      preserveTrackedBrowserOnEngineFailure: testCase.preserveTrackedBrowserOnEngineFailure,
    });
    startAgent.mockRejectedValueOnce(new Error("realtime startup failed"));
    const runtime = createPluginRuntime();
    vi.spyOn(runtime.system, "runCommandWithTimeout").mockResolvedValue(
      createCommandResult({ stdout: "BlackHole 2ch" }),
    );
    const launch = () =>
      transport.launchInChrome({
        ...launchParams,
        runtime,
        trackedTargetId: "tracked-tab",
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
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /audio transport cleanup after realtime startup failure.*cleanup failed/,
      ),
    );
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(browserMocks.leave).toHaveBeenCalledTimes(testCase.expectedLeaves * 2);
    const recovered = await launch();
    expect(recovered.audioBridge).toEqual({ type: "command-pair", ...engine });
  });

  it.each(["rollback", "owned-constructor", "owned-dispose", "owned-node-stop"] as const)(
    "reports failed node cleanup without replacing the startup error (%s)",
    async (scenario) => {
      const { transport, createBindings, createNodeAudioTransport, nodeAudioTransport } =
        mockTransport(
          { startupFailurePolicy: scenario === "rollback" ? "rollback" : "owned" },
          true,
        );
      const startupFailure = new Error("meeting startup refused");
      const cleanupToken = "sk-abcdefghijklmnopqrstuv";
      const cleanupFailure = new Error(`Authorization: Bearer ${cleanupToken}`);
      if (scenario === "owned-constructor") {
        createNodeAudioTransport.mockImplementationOnce(() => {
          throw startupFailure;
        });
      } else if (scenario === "owned-dispose" || scenario === "owned-node-stop") {
        createBindings.mockImplementationOnce(() => {
          throw startupFailure;
        });
        if (scenario === "owned-node-stop") {
          createNodeAudioTransport.mockImplementationOnce(createNodeMeetingRealtimeAudioTransport);
        } else {
          nodeAudioTransport.dispose.mockRejectedValueOnce(cleanupFailure);
        }
      }
      openedTab("owned-tab", true);
      let startAttempted = false;
      const runtime = createPluginRuntime();
      const invoke = vi.spyOn(runtime.nodes, "invoke").mockImplementation(async ({ params }) => {
        const action = asOptionalRecord(params)?.action;
        if (action === "start") {
          startAttempted = true;
          if (scenario === "rollback") {
            throw startupFailure;
          }
          return { payload: { audioBridge: { type: "node-command-pair" }, bridgeId: "bridge-1" } };
        }
        if (action === "stop" || (action === "stopByUrl" && startAttempted)) {
          throw cleanupFailure;
        }
        return { payload: { ok: true } };
      });

      await expect(transport.launchOnNode({ ...launchParams, runtime })).rejects.toBe(
        startupFailure,
      );
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String));
      expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).not.toContain(cleanupToken);
      expect(browserMocks.leave).toHaveBeenCalledOnce();
      if (scenario === "owned-constructor" || scenario === "owned-node-stop") {
        expect(invoke).toHaveBeenCalledWith(
          expect.objectContaining({ params: { action: "stop", bridgeId: "bridge-1" } }),
        );
      } else if (scenario === "owned-dispose") {
        expect(nodeAudioTransport.dispose).toHaveBeenCalledOnce();
        expect(
          invoke.mock.calls.some(([call]) => asOptionalRecord(call.params)?.action === "stop"),
        ).toBe(false);
      } else {
        expect(
          invoke.mock.calls.filter(
            ([call]) => asOptionalRecord(call.params)?.action === "stopByUrl",
          ),
        ).toHaveLength(2);
      }
    },
  );

  it("enables output generations when the node host advertises support", async () => {
    const { transport, nodeAudioTransport } = mockTransport({}, true);
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      return params.action === "start"
        ? {
            payload: {
              audioBridge: { type: "node-command-pair", outputGeneration: true },
              bridgeId: "bridge-1",
              launched: true,
            },
          }
        : { payload: { ok: true } };
    });
    const runtime = { nodes: { invoke } } as unknown as PluginRuntime;

    const result = await transport.launchOnNode({ ...launchParams, runtime });
    expect(result.audioBridge).toMatchObject({ type: "node-command-pair", providerId: "openai" });
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
  beforeEach(() => openedTab("audio-tab"));
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
      const normalized = configSchema.resolveConfig({
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
      const session = { connect: async () => {}, close() {}, isConnected: () => true, sendAudio };
      const providers = [
        {
          id: "test",
          label: "Test",
          isConfigured: () => true,
          createSession: () => session,
          createBridge: () => ({
            ...session,
            handleBargeIn() {},
            setMediaTimestamp() {},
            acknowledgeMark() {},
            submitToolResult() {},
          }),
        },
      ];
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
      vi.spyOn(runtime.system, "runCommandWithTimeout").mockResolvedValue(
        createCommandResult({ stdout: "BlackHole 2ch" }),
      );
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
      const transport = createTransport({
        ...transportOptions,
        platform: {
          ...platform,
          browser: { ...platform.browser, buildAudioCaptureScript: JSON.stringify },
        },
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
            startMeetingAgentRealtimeEngine({ ...params, providers }),
          startRealtimeEngine: (params) => startMeetingRealtimeEngine({ ...params, providers }),
        },
      });
      const launch = host === "local" ? transport.launchInChrome : transport.launchOnNode;
      const result = await launch({
        ...launchParams,
        config: normalized,
        fullConfig: {},
        meetingSessionId: "input-session",
        mode,
        runtime,
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
