import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import {
  ensureMeetingAudioBackend,
  resolveMeetingAudioRuntimeForFormat,
  type MeetingAudioBackend,
  type MeetingAudioRuntime,
} from "./audio-backend.js";
import { openMeetingWithBrowser, recoverMeetingBrowserTab } from "./browser-controller.js";
import { callMeetingBrowserProxyOnNode, resolveMeetingBrowserNode } from "./browser-node.js";
import { resolveLocalMeetingBrowserRequest } from "./browser-request.js";
import {
  leaveMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
} from "./browser-session-control.js";
import { parseMeetingChromeNodeResult } from "./chrome-node-result.js";
import type {
  CommandPairAudioBridge,
  ExternalAudioBridge,
  MeetingChromeLaunchParams,
  MeetingChromeRecoveryParams,
  NodeAudioBridge,
  MeetingChromeTransportConfig,
  MeetingChromeTransportOptions,
} from "./chrome-transport-types.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";
import type { MeetingRealtimeAudioEngineHandle } from "./realtime-engine.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

export type {
  MeetingChromeTransportConfig,
  MeetingChromeTransportOptions,
} from "./chrome-transport-types.js";

function createMeetingChromeTransportWithAudioPolicy<
  Config extends MeetingChromeTransportConfig,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  LocalBridge extends CommandPairAudioBridge,
  ExternalBridge extends ExternalAudioBridge,
>(
  options: MeetingChromeTransportOptions<Mode, Health, Transcript>,
  audioBridge: {
    local(engine: MeetingRealtimeAudioEngineHandle, audio: MeetingAudioRuntime): LocalBridge;
    external?: () => ExternalBridge;
  },
) {
  async function openOrRecoverMeeting(params: {
    callBrowser: MeetingBrowserRequestCaller;
    config: Config;
    fullConfig: OpenClawConfig;
    meetingSessionId: string;
    mode: Mode;
    trackedTargetId?: string;
    url: string;
    locationLabel: string;
  }) {
    const captureCaptions =
      params.mode === "transcribe" ||
      resolveTranscriptsConfig(params.fullConfig.transcripts).enabled;
    if (params.config.chrome.launch) {
      return await openMeetingWithBrowser({
        adapter: options.platform,
        callBrowser: params.callBrowser,
        config: params.config.chrome,
        session: {
          captureCaptions,
          meetingSessionId: params.meetingSessionId,
          mode: params.mode,
          url: params.url,
        },
      });
    }
    const recovered = await recoverMeetingBrowserTab({
      adapter: options.platform,
      allowSessionAdoption: true,
      autoJoin: params.config.chrome.autoJoin,
      callBrowser: params.callBrowser,
      captureCaptions,
      config: params.config.chrome,
      locationLabel: params.locationLabel,
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.url,
      trackedTargetId: params.trackedTargetId,
    });
    return {
      launched: false,
      browser: recovered.browser,
      tab: recovered.targetId ? { targetId: recovered.targetId, openedByPlugin: false } : undefined,
    };
  }

  async function rollbackBrowserJoin(params: {
    callBrowser: MeetingBrowserRequestCaller;
    config: Config;
    logger: RuntimeLogger;
    meetingSessionId: string;
    tab?: MeetingBrowserTab;
    url: string;
  }) {
    if (!params.tab) {
      return;
    }
    if (
      options.startupFailurePolicy === "owned" &&
      (!params.config.chrome.launch || !params.tab.openedByPlugin)
    ) {
      return;
    }
    const result = await leaveMeetingWithBrowser({
      adapter: options.platform,
      callBrowser: params.callBrowser,
      launch: true,
      meetingSessionId: params.meetingSessionId,
      meetingUrl: params.url,
      tab: params.tab,
      timeoutMs: params.config.chrome.joinTimeoutMs,
    }).catch((error: unknown) => ({
      left: false,
      note: error instanceof Error ? error.message : String(error),
    }));
    if (!result.left) {
      params.logger.warn(
        `${options.platform.logScope} browser rollback after realtime startup failure did not complete: ${result.note}`,
      );
    }
  }

  async function prepareAudioRuntime(params: {
    runtime: PluginRuntime;
    config: Config;
    timeoutMs: number;
  }): Promise<MeetingAudioRuntime> {
    const audio = resolveMeetingAudioRuntimeForFormat({
      backend: params.config.chrome.audioBackend,
      bufferBytes: params.config.chrome.audioBufferBytes,
      format: params.config.chrome.audioFormat,
      inputCommand: params.config.chrome.audioInputCommandOverride,
      outputCommand: params.config.chrome.audioOutputCommandOverride,
    });
    await ensureMeetingAudioBackend({
      backend: audio.backend,
      timeoutMs: params.timeoutMs,
      run: async (argv, timeoutMs) => {
        const result = await params.runtime.system.runCommandWithTimeout(argv, { timeoutMs });
        return { ...result, code: result.code ?? 1 };
      },
    });
    return audio;
  }

  async function assertAudioDeviceAvailable(params: {
    runtime: PluginRuntime;
    config: Config;
    timeoutMs: number;
  }): Promise<void> {
    await prepareAudioRuntime(params);
  }

  async function startLocalAudioBridge(
    params: MeetingChromeLaunchParams<Config, Mode> & { audio: MeetingAudioRuntime },
  ): Promise<LocalBridge | ExternalBridge | undefined> {
    if (!options.isTalkBackMode(params.mode)) {
      return undefined;
    }
    if (audioBridge.external) {
      if (params.config.chrome.audioBridgeCommand) {
        if (params.mode === "agent") {
          throw new Error(
            "Chrome agent mode requires chrome.audioInputCommand and chrome.audioOutputCommand so OpenClaw can run STT and regular TTS directly.",
          );
        }
        const bridge = await params.runtime.system.runCommandWithTimeout(
          params.config.chrome.audioBridgeCommand,
          { timeoutMs: params.config.chrome.joinTimeoutMs },
        );
        if (bridge.code !== 0) {
          throw new Error(
            `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
          );
        }
        return audioBridge.external();
      }
      if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
        throw new Error(
          "Chrome talk-back mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
        );
      }
    }
    const transport = options.runtime.createLocalAudioTransport({
      inputCommand: params.audio.inputCommand,
      outputCommand: params.audio.outputCommand,
      audioFormat: params.config.chrome.audioFormat,
      bargeInInputCommand: params.config.chrome.bargeInInputCommand,
      bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
      bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
      bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
      logger: params.logger,
      logScope: options.platform.logScope,
    });
    try {
      const bindings = options.runtime.createBindings({
        platform: options.platform,
        ...params,
      });
      const engine =
        params.mode === "agent"
          ? await options.runtime.startAgentRealtimeEngine({
              config: params.config,
              fullConfig: params.fullConfig,
              runtime: params.runtime,
              platform: bindings.platform,
              meetingSessionId: params.meetingSessionId,
              requesterSessionKey: params.requesterSessionKey,
              transport,
              logger: params.logger,
              consultAgent: bindings.consultAgent,
            })
          : await options.runtime.startRealtimeEngine({
              config: {
                ...params.config,
                realtime: { ...params.config.realtime, strategy: "bidi" },
              },
              fullConfig: params.fullConfig,
              runtime: params.runtime,
              ...bindings,
              meetingSessionId: params.meetingSessionId,
              requesterSessionKey: params.requesterSessionKey,
              transport,
              logger: params.logger,
            });
      return audioBridge.local(engine, params.audio);
    } catch (error) {
      await transport.dispose().catch(() => {});
      throw error;
    }
  }

  async function launchInChrome(params: MeetingChromeLaunchParams<Config, Mode>): Promise<{
    launched: boolean;
    audioBackend?: MeetingAudioBackend;
    audioBridge?: LocalBridge | ExternalBridge;
    browser?: Health;
    tab?: MeetingBrowserTab;
  }> {
    const audio = options.isTalkBackMode(params.mode)
      ? await prepareAudioRuntime({
          runtime: params.runtime,
          config: params.config,
          timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
        })
      : undefined;
    if (audio && audioBridge.external && params.config.chrome.audioBridgeHealthCommand) {
      const health = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeHealthCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (health.code !== 0) {
        throw new Error(
          `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
        );
      }
    }
    const callBrowser = await resolveLocalMeetingBrowserRequest(params.runtime);
    const result = await openOrRecoverMeeting({
      callBrowser,
      config: params.config,
      fullConfig: params.fullConfig,
      locationLabel: "in local Chrome",
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      trackedTargetId: params.trackedTargetId,
      url: params.url,
    });
    if (!options.isRealtimeRouteReady(params.mode, result.browser)) {
      return { ...result, audioBackend: audio?.backend };
    }
    try {
      return {
        ...result,
        audioBackend: audio?.backend,
        audioBridge: audio ? await startLocalAudioBridge({ ...params, audio }) : undefined,
      };
    } catch (error) {
      if (!options.preserveTrackedBrowserOnEngineFailure || !params.trackedTargetId) {
        await rollbackBrowserJoin({
          callBrowser,
          config: params.config,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          tab: result.tab,
          url: params.url,
        });
      }
      throw error;
    }
  }

  async function resolveChromeNode(params: {
    runtime: PluginRuntime;
    requestedNode?: string;
  }): Promise<string> {
    return await resolveMeetingBrowserNode({
      ...params,
      adapter: options.browserNodeAdapter,
    });
  }

  async function callNodeBrowser(params: {
    runtime: PluginRuntime;
    nodeId: string;
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    timeoutMs: number;
  }) {
    return await callMeetingBrowserProxyOnNode({
      ...params,
      adapter: options.browserNodeAdapter,
    });
  }

  const parseNodeResult = (raw: unknown) =>
    parseMeetingChromeNodeResult<Health>(
      raw,
      `${options.meetingLabel} node returned an invalid start result.`,
    );

  async function launchOnNode(params: MeetingChromeLaunchParams<Config, Mode>): Promise<{
    nodeId: string;
    launched: boolean;
    audioBackend?: MeetingAudioBackend;
    audioBridge?: NodeAudioBridge | ExternalBridge;
    browser?: Health;
    tab?: MeetingBrowserTab;
  }> {
    const nodeId = await resolveChromeNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
    });
    try {
      await params.runtime.nodes.invoke({
        nodeId,
        command: options.nodeCommandName,
        params: { action: "stopByUrl", url: params.url, mode: params.mode },
        timeoutMs: 5_000,
      });
    } catch (error) {
      params.logger.debug?.(
        `${options.platform.logScope} node bridge cleanup ignored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const audioSetup = options.isTalkBackMode(params.mode)
      ? parseNodeResult(
          await params.runtime.nodes.invoke({
            nodeId,
            command: options.nodeCommandName,
            params: {
              action: "setup",
              audioBackend: params.config.chrome.audioBackend,
              audioFormat: params.config.chrome.audioFormat,
              audioBufferBytes: params.config.chrome.audioBufferBytes,
              ...(params.config.chrome.audioInputCommandOverride
                ? { audioInputCommand: params.config.chrome.audioInputCommandOverride }
                : {}),
              ...(params.config.chrome.audioOutputCommandOverride
                ? { audioOutputCommand: params.config.chrome.audioOutputCommandOverride }
                : {}),
            },
            timeoutMs: 12_000,
          }),
        )
      : undefined;
    const callBrowser: MeetingBrowserRequestCaller = async (request) =>
      await callNodeBrowser({
        runtime: params.runtime,
        nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      });
    const browser = await openOrRecoverMeeting({
      callBrowser,
      config: params.config,
      fullConfig: params.fullConfig,
      locationLabel: "on the selected Chrome node",
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      trackedTargetId: params.trackedTargetId,
      url: params.url,
    });
    if (!options.isRealtimeRouteReady(params.mode, browser.browser)) {
      return {
        nodeId,
        launched: browser.launched,
        audioBackend: audioSetup?.audioBackend,
        browser: browser.browser,
        tab: browser.tab,
      };
    }
    let startedBridgeId: string | undefined;
    let audioTransport: ReturnType<typeof options.runtime.createNodeAudioTransport> | undefined;
    try {
      const raw = await params.runtime.nodes.invoke({
        nodeId,
        command: options.nodeCommandName,
        params: {
          action: "start",
          url: params.url,
          mode: params.mode,
          launch: false,
          browserProfile: params.config.chrome.browserProfile,
          joinTimeoutMs: params.config.chrome.joinTimeoutMs,
          ...(params.config.chrome.audioInputCommandOverride
            ? { audioInputCommand: params.config.chrome.audioInputCommandOverride }
            : {}),
          ...(params.config.chrome.audioOutputCommandOverride
            ? { audioOutputCommand: params.config.chrome.audioOutputCommandOverride }
            : {}),
          audioBackend: params.config.chrome.audioBackend,
          audioFormat: params.config.chrome.audioFormat,
          audioBufferBytes: params.config.chrome.audioBufferBytes,
          ...(audioBridge.external
            ? {
                audioBridgeCommand: params.config.chrome.audioBridgeCommand,
                audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand,
              }
            : {}),
        },
        timeoutMs: addTimerTimeoutGraceMs(params.config.chrome.joinTimeoutMs) ?? 1,
      });
      const result = parseNodeResult(raw);
      if (result.audioBridge?.type !== "node-command-pair") {
        return {
          nodeId,
          launched: browser.launched || result.launched === true,
          audioBackend: result.audioBackend ?? audioSetup?.audioBackend,
          browser: browser.browser ?? result.browser,
          tab: browser.tab,
          ...(audioBridge.external && result.audioBridge?.type === "external-command"
            ? { audioBridge: audioBridge.external() }
            : {}),
        };
      }
      if (!result.bridgeId) {
        throw new Error(`${options.meetingLabel} node did not return an audio bridge id.`);
      }
      startedBridgeId = result.bridgeId;
      const transport = options.runtime.createNodeAudioTransport({
        runtime: params.runtime,
        nodeId,
        bridgeId: result.bridgeId,
        audioFormat: params.config.chrome.audioFormat,
        logger: params.logger,
        commandName: options.nodeCommandName,
        logScope: options.platform.logScope,
        logPrefix: params.mode === "agent" ? "node agent" : "node",
      });
      audioTransport = transport;
      Reflect.set(
        transport,
        Symbol.for("openclaw.internal.meeting-node-output-generation.v1"),
        result.audioBridge.outputGeneration === true,
      );
      const bindings = options.runtime.createBindings({
        platform: options.platform,
        ...params,
      });
      const engine =
        params.mode === "agent"
          ? await options.runtime.startAgentRealtimeEngine({
              config: params.config,
              fullConfig: params.fullConfig,
              runtime: params.runtime,
              platform: bindings.platform,
              meetingSessionId: params.meetingSessionId,
              requesterSessionKey: params.requesterSessionKey,
              logPrefix: "node",
              transport,
              logger: params.logger,
              consultAgent: bindings.consultAgent,
            })
          : await options.runtime.startRealtimeEngine({
              config: {
                ...params.config,
                realtime: { ...params.config.realtime, strategy: "bidi" },
              },
              fullConfig: params.fullConfig,
              runtime: params.runtime,
              ...bindings,
              meetingSessionId: params.meetingSessionId,
              requesterSessionKey: params.requesterSessionKey,
              logPrefix: "node",
              talkSessionId: `${options.platform.id}:${params.meetingSessionId}:${result.bridgeId}:node-realtime`,
              talkContext: { nodeId, bridgeId: result.bridgeId },
              transport,
              logger: params.logger,
            });
      return {
        nodeId,
        launched: browser.launched || result.launched === true,
        audioBackend: result.audioBackend ?? audioSetup?.audioBackend,
        audioBridge: {
          type: "node-command-pair",
          nodeId,
          bridgeId: result.bridgeId,
          ...engine,
        },
        browser: browser.browser ?? result.browser,
        tab: browser.tab,
      };
    } catch (error) {
      await audioTransport?.dispose().catch(() => {});
      if (options.startupFailurePolicy === "owned") {
        if (!audioTransport && startedBridgeId) {
          await params.runtime.nodes
            .invoke({
              nodeId,
              command: options.nodeCommandName,
              params: { action: "stop", bridgeId: startedBridgeId },
              timeoutMs: 5_000,
            })
            .catch(() => {});
        }
      } else {
        await params.runtime.nodes
          .invoke({
            nodeId,
            command: options.nodeCommandName,
            params: { action: "stopByUrl", url: params.url, mode: params.mode },
            timeoutMs: 5_000,
          })
          .catch(() => {});
      }
      if (!options.preserveTrackedBrowserOnEngineFailure || !params.trackedTargetId) {
        await rollbackBrowserJoin({
          callBrowser,
          config: params.config,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          tab: browser.tab,
          url: params.url,
        });
      }
      throw error;
    }
  }

  async function recoverCurrentTab(params: MeetingChromeRecoveryParams<Config, Mode>) {
    const nodeId =
      params.transport === "chrome-node"
        ? (params.nodeId ??
          (await resolveChromeNode({
            runtime: params.runtime,
            requestedNode: params.config.chromeNode.node,
          })))
        : undefined;
    return {
      transport: params.transport,
      ...(nodeId ? { nodeId } : {}),
      ...(await recoverMeetingBrowserTab({
        adapter: options.platform,
        callBrowser: nodeId
          ? async (request) =>
              await callNodeBrowser({
                runtime: params.runtime,
                nodeId,
                method: request.method,
                path: request.path,
                body: request.body,
                timeoutMs: request.timeoutMs,
              })
          : await resolveLocalMeetingBrowserRequest(params.runtime),
        captureCaptions:
          params.mode === "transcribe" ||
          resolveTranscriptsConfig(params.fullConfig?.transcripts).enabled,
        config: params.config.chrome,
        locationLabel: nodeId ? "on the selected Chrome node" : "in local Chrome",
        meetingSessionId: params.meetingSessionId,
        mode: params.mode,
        readOnly: params.readOnly,
        requestedMeetingUrl: params.url,
        trackedMeetingUrl: params.trackedMeetingUrl,
        trackedTargetId: params.trackedTargetId,
        timeoutMs: params.timeoutMs,
      })),
    };
  }

  async function leaveInBrowser(params: {
    runtime: PluginRuntime;
    config: Config;
    meetingSessionId: string;
    meetingUrl: string;
    nodeId?: string;
    tab: MeetingBrowserTab;
  }) {
    const nodeId = params.nodeId;
    return await leaveMeetingWithBrowser({
      adapter: options.platform,
      callBrowser: nodeId
        ? async (request) =>
            await callNodeBrowser({
              runtime: params.runtime,
              nodeId,
              method: request.method,
              path: request.path,
              body: request.body,
              timeoutMs: request.timeoutMs,
            })
        : await resolveLocalMeetingBrowserRequest(params.runtime),
      launch: params.config.chrome.launch || !params.tab.openedByPlugin,
      meetingSessionId: params.meetingSessionId,
      meetingUrl: params.meetingUrl,
      tab: params.tab,
      timeoutMs: params.config.chrome.joinTimeoutMs,
    });
  }

  async function readTranscript(params: {
    runtime: PluginRuntime;
    config: Config;
    finalize?: boolean;
    meetingUrl: string;
    meetingSessionId: string;
    nodeId?: string;
    tab: MeetingBrowserTab;
  }): Promise<Transcript> {
    const nodeId = params.nodeId;
    return await readMeetingTranscriptWithBrowser({
      adapter: options.platform,
      callBrowser: nodeId
        ? async (request) =>
            await callNodeBrowser({
              runtime: params.runtime,
              nodeId,
              method: request.method,
              path: request.path,
              body: request.body,
              timeoutMs: request.timeoutMs,
            })
        : await resolveLocalMeetingBrowserRequest(params.runtime),
      finalize: params.finalize === true,
      meetingUrl: params.meetingUrl,
      meetingSessionId: params.meetingSessionId,
      tab: params.tab,
      timeoutMs: Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000),
    });
  }
  return {
    assertAudioDeviceAvailable,
    launchInChrome,
    launchOnNode,
    leaveInBrowser,
    readTranscript,
    recoverCurrentTab,
  };
}

export function createMeetingChromeTransport<
  Config extends MeetingChromeTransportConfig,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(options: MeetingChromeTransportOptions<Mode, Health, Transcript>) {
  return createMeetingChromeTransportWithAudioPolicy<
    Config,
    Mode,
    Health,
    Transcript,
    CommandPairAudioBridge,
    never
  >(options, {
    local: (engine) => ({ type: "command-pair", ...engine }),
  });
}

export function createMeetingChromeTransportWithExternalAudio<
  Config extends MeetingChromeTransportConfig,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(options: MeetingChromeTransportOptions<Mode, Health, Transcript>) {
  return createMeetingChromeTransportWithAudioPolicy<
    Config,
    Mode,
    Health,
    Transcript,
    CommandPairAudioBridge & Pick<MeetingAudioRuntime, "inputCommand" | "outputCommand">,
    ExternalAudioBridge
  >(options, {
    local: (engine, audio) => ({
      type: "command-pair",
      inputCommand: audio.inputCommand,
      outputCommand: audio.outputCommand,
      ...engine,
    }),
    external: () => ({ type: "external-command" }),
  });
}
