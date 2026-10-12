import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { Type } from "typebox";
import { normalizeAgentId } from "../routing/session-key.js";
import { isMeetingTalkBackMode } from "./meeting-modes.js";
import type { registerMeetingPluginCli } from "./plugin-cli.js";
import { createMeetingPluginConfigSchema, type MeetingPluginConfig } from "./plugin-config.js";
import {
  createMeetingChromeRuntimeBindings,
  createMeetingPluginChromeTransport,
  createMeetingPluginNodeHostHandler,
  createMeetingPluginNodeInvokePolicy,
  createMeetingPluginShellEntry,
} from "./plugin-shell.js";
import type { MeetingRuntimeFacadeOptions } from "./runtime-facade-types.js";
import { createMeetingRuntimeFacade } from "./runtime-facade.js";
import { createMeetingRuntimeProbes, resolveMeetingProbeTimeoutMs } from "./runtime-probes.js";
import { createMeetingRuntimeSetup } from "./runtime-setup.js";
import type {
  MeetingPluginChromeHealth,
  MeetingPluginJoinRequest,
  MeetingPluginSession,
} from "./session-types.js";

type Mode = MeetingPluginConfig["defaultMode"];
type Transport = "chrome" | "chrome-node";
type Request = MeetingPluginJoinRequest<Transport, Mode>;
type CommonSpeechReason = "not-in-call" | "browser-unverified" | "audio-bridge-unavailable";
type BrowserHealth<
  ManualReason extends string,
  SpeechReason extends string,
> = MeetingPluginChromeHealth<ManualReason, SpeechReason | CommonSpeechReason> & {
  meetingEnded?: boolean;
};
type RuntimeOptions<Health extends MeetingPluginChromeHealth<string, string>> =
  MeetingRuntimeFacadeOptions<
    MeetingPluginConfig,
    Transport,
    Mode,
    Health,
    { setup: unknown; listening: unknown; speech: unknown }
  >;
type CliTimeoutOptions = { probe: boolean; requestedTimeoutMs?: number };

export function defineBrowserMeetingPlugin<
  ManualReason extends string,
  SpeechReason extends string,
>(spec: {
  platform: RuntimeOptions<BrowserHealth<ManualReason, SpeechReason>>["platform"];
  labels: {
    meeting: string;
    participant: string;
    brand: string;
    microphone: string;
    browserPage: string;
    tab?: string;
  };
  config: Parameters<typeof createMeetingPluginConfigSchema>[0];
  chromeRuntime?: ReturnType<typeof createMeetingChromeRuntimeBindings>;
  InvalidRequestError: new (message: string) => Error;
  toolUrlDescription: string;
  transcriptSource: { id: string; aliases: readonly string[]; providerName: string };
  hooks?: RuntimeOptions<BrowserHealth<ManualReason, SpeechReason>>["hooks"];
  browserReadinessFailed?: (error: string) => string;
  notInCallMessage?: string;
  microphoneMutedReason: SpeechReason;
  setup: Omit<
    Parameters<typeof createMeetingRuntimeSetup<MeetingPluginConfig, Mode>>[0],
    "assertAudioDeviceAvailable" | "nodeAdapter"
  >;
  shouldWaitForListening: (
    session: MeetingPluginSession<Transport, Mode, BrowserHealth<ManualReason, SpeechReason>>,
  ) => boolean;
  defaultSpeechMessage: string;
  sharePrerequisiteDeadline: boolean;
  preserveTrackedBrowserOnEngineFailure: boolean;
  nodePolicyDeniedCode: string;
  cli: {
    descriptor: Parameters<typeof createMeetingPluginShellEntry>[0]["cli"]["descriptor"];
    joinDescription: string;
    callGateway?: Parameters<typeof registerMeetingPluginCli>[0]["callGateway"];
    resolveTimeoutMs?(operationTimeoutMs: number, options: CliTimeoutOptions): number;
  };
  entry?: Pick<
    Parameters<typeof createMeetingPluginShellEntry>[0],
    | "normalizeRequesterSessionKey"
    | "normalizeToolAgentId"
    | "resolveToolRuntime"
    | "registerNodeWhen"
  >;
}) {
  type Health = BrowserHealth<ManualReason, SpeechReason>;
  const { platform, labels } = spec;
  const tabLabel = labels.tab ?? labels.meeting;
  const config = createMeetingPluginConfigSchema(spec.config);
  const invalidRequest = (message: string) => new spec.InvalidRequestError(message);
  const chrome = createMeetingPluginChromeTransport({
    meetingLabel: labels.meeting,
    platform,
    preserveTrackedBrowserOnEngineFailure: spec.preserveTrackedBrowserOnEngineFailure,
    runtime: spec.chromeRuntime ?? createMeetingChromeRuntimeBindings(),
  });
  const setupStatus = createMeetingRuntimeSetup<MeetingPluginConfig, Mode>({
    ...spec.setup,
    assertAudioDeviceAvailable: chrome.assertAudioDeviceAvailable,
    nodeAdapter: platform,
  });
  const probes = createMeetingRuntimeProbes<
    MeetingPluginConfig,
    Mode,
    Transport,
    Health,
    MeetingPluginSession<Transport, Mode, Health>,
    Request
  >({
    defaultSpeechMessage: spec.defaultSpeechMessage,
    invalidRequest,
    resolveTimeoutMs: (input, fallback) =>
      resolveMeetingProbeTimeoutMs(input, fallback, invalidRequest),
    shouldWaitForListening: spec.shouldWaitForListening,
    talkBackMode: isMeetingTalkBackMode,
  });
  const Runtime = createMeetingRuntimeFacade<
    MeetingPluginConfig,
    Transport,
    Mode,
    Health,
    {
      setup: Awaited<ReturnType<typeof setupStatus>>;
      listening: Awaited<ReturnType<typeof probes.testListening>>;
      speech: Awaited<ReturnType<typeof probes.testSpeech>>;
    }
  >({
    platform,
    transport: chrome,
    probes: { setupStatus, ...probes },
    hooks: spec.hooks,
    messages: {
      browserReadinessFailed: spec.browserReadinessFailed,
      durableTranscripts: {
        providerId: spec.transcriptSource.id,
        providerName: spec.transcriptSource.providerName,
      },
      joined: {
        local: `${labels.participant} joined in local Chrome with realtime audio through the native virtual-audio backend.`,
        node: `${labels.participant} joined in Chrome on the selected node with realtime audio through the node bridge.`,
        transcribe: `${labels.participant} joined observe-only with live-caption transcript capture.`,
        waiting: `${labels.participant} join is waiting for the browser to become ready before starting realtime audio.`,
      },
      leaveFailed: (error) => `Browser control could not leave the ${tabLabel} tab: ${error}`,
      noTrackedTab: `No tracked ${tabLabel} tab; leave the browser meeting manually if it is still active.`,
      sharedTab: `Kept the shared ${tabLabel} tab open for another active session.`,
      sessionRuntime: {
        previousBrowserLeaveFailed: `Could not leave the previous ${tabLabel} tab before reassignment.`,
        replacementBrowserLeaveFailed: `Could not leave the previous ${tabLabel} tab before reassignment.`,
        reassignedSessionNote: `Ended before the same ${tabLabel} tab was reassigned to another agent.`,
        reusedSessionNote: `Reused existing active ${labels.brand} meeting session.`,
        speechBlockedFallback: `Realtime speech blocked until ${labels.brand} is ready.`,
        speech: {
          audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
          browserUnverified: `${labels.brand} browser state has not been verified yet.`,
          microphoneMuted: `Turn on the OpenClaw ${labels.microphone} microphone before asking OpenClaw to speak.`,
          microphoneMutedReason: spec.microphoneMutedReason,
          notInCall:
            spec.notInCallMessage ??
            `${labels.brand} has not reported that the browser guest is in the call.`,
          notInCallReason: "not-in-call",
          browserUnverifiedReason: "browser-unverified",
          audioBridgeUnavailableReason: "audio-bridge-unavailable",
        },
      },
    },
  });
  const nodeHandler = createMeetingPluginNodeHostHandler({
    platform,
    browserPageName: labels.browserPage,
    meetingLabel: labels.meeting,
    defaultAudioInputCommand: config.defaultAudioInputCommand,
    defaultAudioOutputCommand: config.defaultAudioOutputCommand,
    sharePrerequisiteDeadline: spec.sharePrerequisiteDeadline,
  });
  const createNodePolicy = (resolved: MeetingPluginConfig) =>
    createMeetingPluginNodeInvokePolicy(resolved, {
      platform,
      deniedCode: spec.nodePolicyDeniedCode,
    });
  const resolveCliGatewayTimeoutMs = (
    resolved: MeetingPluginConfig,
    options: CliTimeoutOptions,
  ): number => {
    const operationTimeoutMs = config.resolveGatewayOperationTimeoutMs(resolved);
    if (spec.cli.resolveTimeoutMs) {
      return spec.cli.resolveTimeoutMs(operationTimeoutMs, options);
    }
    const probeTimeoutMs = options.probe
      ? resolveMeetingProbeTimeoutMs(
          options.requestedTimeoutMs,
          resolved.chrome.joinTimeoutMs,
          invalidRequest,
        )
      : undefined;
    return probeTimeoutMs === undefined
      ? operationTimeoutMs
      : (addTimerTimeoutGraceMs(operationTimeoutMs, probeTimeoutMs) ?? 1);
  };
  const loadCli = async () => {
    const { registerBrowserMeetingCli } = await import("./browser-plugin-cli.js");
    return (params: { program: Command; config: MeetingPluginConfig }) =>
      registerBrowserMeetingCli({
        ...params,
        callGateway: spec.cli.callGateway,
        descriptor: spec.cli.descriptor,
        joinDescription: spec.cli.joinDescription,
        meetingLabel: tabLabel,
        resolveTimeoutMs: resolveCliGatewayTimeoutMs,
      });
  };
  const plugin = createMeetingPluginShellEntry({
    platform,
    browserGuestLabel: labels.meeting,
    configSchema: config.configSchema,
    invalidRequest,
    isInvalidRequest: (error) => error instanceof spec.InvalidRequestError,
    toolParameters: Type.Object({
      action: Type.String({ enum: ["join", "leave", "status", "transcript", "speak"] }),
      url: Type.Optional(Type.String({ description: spec.toolUrlDescription })),
      transport: Type.Optional(Type.String({ enum: ["chrome", "chrome-node"] })),
      mode: Type.Optional(Type.String({ enum: ["agent", "bidi", "transcribe"] })),
      sessionId: Type.Optional(Type.String({ description: `${tabLabel} session ID` })),
      sinceIndex: Type.Optional(
        Type.Integer({ minimum: 0, description: "Resume transcript from this index" }),
      ),
      message: Type.Optional(Type.String({ description: "Instructions to speak" })),
    }),
    resolveGatewayTimeoutMs: config.resolveGatewayOperationTimeoutMs,
    normalizeRequesterSessionKey: (value, trustedOwner) =>
      trustedOwner && typeof value === "string" && value.trim() ? value.trim() : undefined,
    normalizeToolAgentId: (agentId) => normalizeAgentId(agentId),
    resolveToolRuntime: async (api) => {
      if (!(await api.runtime.gateway.isAvailable())) {
        throw new Error(`${labels.meeting} tools require a Gateway-hosted agent run.`);
      }
      return api.runtime;
    },
    transcriptSource: { id: spec.transcriptSource.id, aliases: spec.transcriptSource.aliases },
    runtime: Runtime,
    nodeHandler,
    createNodePolicy,
    registerNodeWhen: (resolved) => resolved.enabled,
    ...spec.entry,
    cli: { descriptor: spec.cli.descriptor, load: loadCli },
  });
  return {
    plugin,
    config,
    chrome,
    Runtime,
    probes,
    setupStatus,
    nodeHandler,
    createNodePolicy,
    loadCli,
    resolveCliGatewayTimeoutMs,
  };
}
