import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { Type } from "typebox";
import { z } from "zod";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { ensureMeetingAudioBackend, resolveMeetingAudioRuntimeForFormat } from "./audio-backend.js";
import { createMeetingBrowserAdapterOptions } from "./browser-adapter-options.js";
import {
  createMeetingChromeTransport,
  createMeetingChromeTransportWithExternalAudio,
} from "./chrome-transport.js";
import { createMeetingConfiguredNodeHost } from "./configured-node-host.js";
import { isMeetingRealtimeRouteReady, isMeetingTalkBackMode } from "./meeting-modes.js";
import { normalizeMeetingObservationProvenance } from "./observation-provenance.js";
import { createMeetingPageScripts } from "./page-script-source.js";
import type {
  MeetingBrowserLeaveStep,
  MeetingPlatformAdapter as MeetingPlatformAdapterContract,
  MeetingPlatformAdapterOptions,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import { registerMeetingPluginCli } from "./plugin-cli.js";
import { createMeetingPluginConfigSchema, type MeetingPluginConfig } from "./plugin-config.js";
import { createMeetingPluginEntryOptions } from "./plugin-entry.js";
import {
  createMeetingChromeRuntimeBindings,
  createMeetingPluginChromeTransport,
  createMeetingPluginNodeHostHandler,
  createMeetingPluginNodeInvokePolicy,
  createMeetingPluginShellEntry,
  createMeetingPluginTypes,
} from "./plugin-shell.js";
import type { MeetingRuntimeFacadeOptions } from "./runtime-facade-types.js";
import { createMeetingRuntimeFacade } from "./runtime-facade.js";
import { createMeetingRuntimeProbes, resolveMeetingProbeTimeoutMs } from "./runtime-probes.js";
import { createMeetingRuntimeSetup } from "./runtime-setup.js";
import {
  meetingCaptionSourceSchema,
  type MeetingBrowserHealth,
  type MeetingTranscriptLine,
  type MeetingTranscriptSnapshot,
  type MeetingPluginChromeHealth,
  type MeetingPluginJoinRequest,
  type MeetingPluginSession,
} from "./session-types.js";
import { createMeetingStatusCallSource } from "./status-call-source.js";
import { createMeetingStatusPreludeSource } from "./status-prejoin-source.js";

type BrowserMeetingMode = MeetingPluginConfig["defaultMode"];
type Transport = "chrome" | "chrome-node";
type Request = MeetingPluginJoinRequest<Transport, BrowserMeetingMode>;
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
    BrowserMeetingMode,
    Health,
    { setup: unknown; listening: unknown; speech: unknown }
  >;
type CliTimeoutOptions = { probe: boolean; requestedTimeoutMs?: number };

function defineBrowserMeetingPlugin<
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
    Parameters<typeof createMeetingRuntimeSetup<MeetingPluginConfig, BrowserMeetingMode>>[0],
    "assertAudioDeviceAvailable" | "nodeAdapter"
  >;
  shouldWaitForListening: (
    session: MeetingPluginSession<
      Transport,
      BrowserMeetingMode,
      BrowserHealth<ManualReason, SpeechReason>
    >,
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
  const setupStatus = createMeetingRuntimeSetup<MeetingPluginConfig, BrowserMeetingMode>({
    ...spec.setup,
    assertAudioDeviceAvailable: chrome.assertAudioDeviceAvailable,
    nodeAdapter: platform,
  });
  const probes = createMeetingRuntimeProbes<
    MeetingPluginConfig,
    BrowserMeetingMode,
    Transport,
    Health,
    MeetingPluginSession<Transport, BrowserMeetingMode, Health>,
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
    BrowserMeetingMode,
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

export type {
  MeetingBrowserJoinSession,
  MeetingBrowserLeaveStep,
  MeetingBrowserPermissionPlan,
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
  MeetingBrowserStatusScriptParams,
  MeetingManualAction,
  MeetingManualActionCategory,
} from "./platform-adapter-contract.js";

export interface MeetingPlatformAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
> extends MeetingPlatformAdapterContract<
  Session,
  Mode,
  Health,
  Transcript,
  CreateParams,
  CreateResult,
  DialInParams,
  DialInPlan
> {}

function browserResultString(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const value = (result as Record<string, unknown>).result;
  return typeof value === "string" && value.trim() ? value : undefined;
}

const optionalBrowserString = z.string().optional().catch(undefined);
const optionalBrowserBoolean = z.boolean().optional().catch(undefined);
const optionalBrowserNumber = z.number().optional().catch(undefined);
const meetingTranscriptLineSchema = z
  .object({
    at: optionalBrowserString,
    speaker: optionalBrowserString,
    text: z.string().refine((value) => value.trim().length > 0),
    provenance: z.unknown().optional(),
  })
  .transform(({ at, speaker, text, provenance }) => ({
    ...(at !== undefined ? { at } : {}),
    ...(speaker !== undefined ? { speaker } : {}),
    text,
    ...(provenance !== undefined ? { provenance } : {}),
  }));

const meetingTranscriptLinesSchema = z
  .array(meetingTranscriptLineSchema.nullable().catch(null))
  .transform((lines) => lines.filter((line) => line !== null));

const meetingCaptionLinesSchema = z
  .array(
    meetingTranscriptLineSchema
      .and(z.object({ source: z.unknown().optional() }))
      .nullable()
      .catch(null),
  )
  .transform((lines) => lines.filter((line) => line !== null));

const meetingBrowserStatusSchema = z.looseObject({
  inCall: optionalBrowserBoolean,
  micMuted: optionalBrowserBoolean,
  cameraOff: optionalBrowserBoolean,
  lobbyWaiting: optionalBrowserBoolean,
  captionCaptureRequested: optionalBrowserBoolean,
  captioning: optionalBrowserBoolean,
  captionsEnabledAttempted: optionalBrowserBoolean,
  transcriptLines: optionalBrowserNumber,
  lastCaptionAt: optionalBrowserString,
  lastCaptionSpeaker: optionalBrowserString,
  lastCaptionText: optionalBrowserString,
  recentTranscript: meetingTranscriptLinesSchema.optional().catch(undefined),
  audioInputRouted: optionalBrowserBoolean,
  audioInputDeviceLabel: optionalBrowserString,
  audioInputRouteError: optionalBrowserString,
  audioOutputRouted: optionalBrowserBoolean,
  audioOutputDeviceLabel: optionalBrowserString,
  audioOutputRouteError: optionalBrowserString,
  audioOutputRouteRetryable: optionalBrowserBoolean,
  manualAction: z.object({ reason: z.string(), message: z.string() }).optional().catch(undefined),
  url: optionalBrowserString,
  title: optionalBrowserString,
  notes: z
    .array(z.string().nullable().catch(null))
    .transform((notes) => notes.filter((note) => note !== null))
    .optional()
    .catch(undefined),
});

function parseMeetingLeaveResult(result: unknown): MeetingBrowserLeaveStep {
  const raw = browserResultString(result);
  if (!raw) {
    return { departed: false };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const leaveAction =
      parsed.leaveAction === "leave" || parsed.leaveAction === "confirm"
        ? parsed.leaveAction
        : undefined;
    return {
      departed: parsed.departed === true,
      ...(leaveAction ? { leaveAction } : {}),
      ...(typeof parsed.sessionConflict === "boolean"
        ? { sessionConflict: parsed.sessionConflict }
        : {}),
      ...(typeof parsed.sessionMatched === "boolean"
        ? { sessionMatched: parsed.sessionMatched }
        : {}),
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
    };
  } catch {
    return { departed: false };
  }
}

function createMeetingPlatformAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
>(
  options: MeetingPlatformAdapterOptions<
    Session,
    Mode,
    Health,
    Transcript,
    CreateParams,
    CreateResult,
    DialInParams,
    DialInPlan
  >,
): MeetingPlatformAdapter<
  Session,
  Mode,
  Health,
  Transcript,
  CreateParams,
  CreateResult,
  DialInParams,
  DialInPlan
> &
  MeetingPlatformRuntimeMetadata {
  const { browser, parsing, ...platform } = options;
  return {
    ...platform,
    browser: {
      ...browser,
      parseStatus: (result) => {
        const adapterId = options.id;
        const raw = browserResultString(result);
        if (!raw) {
          return undefined;
        }
        let parsed: z.infer<typeof meetingBrowserStatusSchema>;
        try {
          parsed = meetingBrowserStatusSchema.parse(JSON.parse(raw));
        } catch {
          throw new Error(parsing.malformedStatusMessage);
        }
        return {
          inCall: parsed.inCall,
          micMuted: parsed.micMuted,
          cameraOff: parsed.cameraOff,
          lobbyWaiting: parsed.lobbyWaiting,
          captionCaptureRequested: parsed.captionCaptureRequested,
          captioning: parsed.captioning,
          captionsEnabledAttempted: parsed.captionsEnabledAttempted,
          transcriptLines: parsed.transcriptLines,
          lastCaptionAt: parsed.lastCaptionAt,
          lastCaptionSpeaker: parsed.lastCaptionSpeaker,
          lastCaptionText: parsed.lastCaptionText,
          recentTranscript: parsed.recentTranscript?.map((line) => ({
            ...line,
            ...(line.provenance !== undefined
              ? {
                  provenance: normalizeMeetingObservationProvenance(line.provenance, {
                    observer: adapterId,
                    observedAt: line.at,
                    speaker: line.speaker,
                  }),
                }
              : {}),
          })),
          audioInputRouted: parsed.audioInputRouted,
          audioInputDeviceLabel: parsed.audioInputDeviceLabel,
          audioInputRouteError: parsed.audioInputRouteError,
          audioOutputRouted: parsed.audioOutputRouted,
          audioOutputDeviceLabel: parsed.audioOutputDeviceLabel,
          audioOutputRouteError: parsed.audioOutputRouteError,
          audioOutputRouteRetryable: parsed.audioOutputRouteRetryable,
          manualAction: parsed.manualAction,
          browserUrl: parsed.url,
          browserTitle: parsed.title,
          status: "browser-control",
          notes: parsed.notes,
          ...parsing.statusFields?.(parsed),
        } as unknown as Health;
      },
      classifyManualAction: (health) => {
        if (!health.manualAction) {
          return undefined;
        }
        return {
          category: parsing.classifyManualActionReason(health.manualAction.reason),
          reason: health.manualAction.reason,
          message: health.manualAction.message,
        };
      },
      parseLeaveResult: parseMeetingLeaveResult,
      captions: {
        ...browser.captions,
        parseTranscript: (result) => {
          const adapterId = options.id;
          const raw = browserResultString(result);
          if (!raw) {
            return { droppedLines: 0, lines: [] } as unknown as Transcript;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error(parsing.malformedTranscriptMessage);
          }
          if (!parsed || typeof parsed !== "object") {
            throw new Error(parsing.invalidTranscriptMessage);
          }
          const payload = parsed as Record<string, unknown>;
          const droppedLines =
            typeof payload.droppedLines === "number" && Number.isSafeInteger(payload.droppedLines)
              ? Math.max(0, payload.droppedLines)
              : 0;
          const parseLines = (values: unknown): MeetingTranscriptLine[] =>
            meetingCaptionLinesSchema
              .catch([])
              .parse(values)
              .map((line) => {
                const source = meetingCaptionSourceSchema.safeParse(line.source);
                const identity =
                  source.success && source.data.epoch === payload.epoch ? source.data : undefined;
                // Legacy rows keep their shape; observation facts do not grant action authority.
                const transcriptLine: MeetingTranscriptLine = { text: line.text };
                if (line.at !== undefined) {
                  transcriptLine.at = line.at;
                }
                if (line.speaker !== undefined) {
                  transcriptLine.speaker = line.speaker;
                }
                if (line.provenance !== undefined || line.source !== undefined) {
                  transcriptLine.provenance = normalizeMeetingObservationProvenance(
                    line.provenance,
                    {
                      observer: adapterId,
                      epoch: payload.epoch,
                      observedAt: line.at,
                      speaker: line.speaker,
                    },
                  );
                }
                if (identity) {
                  transcriptLine.source = identity;
                }
                return transcriptLine;
              });
          return {
            droppedLines,
            ...(typeof payload.epoch === "string" ? { epoch: payload.epoch } : {}),
            lines: parseLines(payload.lines),
            ...(Array.isArray(payload.pendingLines)
              ? { pendingLines: parseLines(payload.pendingLines) }
              : {}),
            ...(typeof payload.urlMatched === "boolean" ? { urlMatched: payload.urlMatched } : {}),
            ...(typeof payload.sessionMatched === "boolean"
              ? { sessionMatched: payload.sessionMatched }
              : {}),
          } as Transcript & { sessionMatched?: boolean; urlMatched?: boolean };
        },
      },
      permissionNotes:
        browser.permissionNotes ??
        (({ allowMicrophone, error, result }) => {
          if (!allowMicrophone) {
            return [`Observe-only mode does not request ${parsing.displayName} microphone access.`];
          }
          if (error) {
            return [
              `Could not grant ${parsing.displayName} media permissions automatically: ${formatErrorMessage(error)}`,
            ];
          }
          const record =
            result && typeof result === "object" ? (result as Record<string, unknown>) : {};
          const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
            ? record.unsupportedPermissions.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          const notes = [
            `Granted ${parsing.displayName} microphone permission through browser control.`,
          ];
          if (unsupportedPermissions.includes("speakerSelection")) {
            notes.push(
              `Chrome did not accept the optional ${parsing.displayName} speaker-selection permission.`,
            );
          }
          return notes;
        }),
    },
  };
}

export const MeetingPlatformAdapter = {
  create: createMeetingPlatformAdapter,
  createBrowserAdapterOptions: createMeetingBrowserAdapterOptions,
  createPageScripts: createMeetingPageScripts,
  defineBrowserMeetingPlugin,
  createChromeTransport: createMeetingChromeTransport,
  createChromeTransportWithExternalAudio: createMeetingChromeTransportWithExternalAudio,
  createChromeRuntimeBindings: createMeetingChromeRuntimeBindings,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createPluginChromeTransport: createMeetingPluginChromeTransport,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createPluginConfigSchema: createMeetingPluginConfigSchema,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createPluginNodeHostHandler: createMeetingPluginNodeHostHandler,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createPluginNodeInvokePolicy: createMeetingPluginNodeInvokePolicy,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createPluginShellEntry: createMeetingPluginShellEntry,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createRuntimeFacade: createMeetingRuntimeFacade,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  createRuntimeSetup: createMeetingRuntimeSetup,
  pluginTypes: createMeetingPluginTypes,
  /** @deprecated Use defineBrowserMeetingPlugin for browser meeting plugins. */
  registerPluginCli: registerMeetingPluginCli,
  resolveProbeTimeoutMs: resolveMeetingProbeTimeoutMs,
  createRuntimeProbes: createMeetingRuntimeProbes,
  createNodeHostHandler: createMeetingConfiguredNodeHost,
  createPluginEntry: createMeetingPluginEntryOptions,
  createStatusCallSource: createMeetingStatusCallSource,
  createStatusPreludeSource: createMeetingStatusPreludeSource,
  isRealtimeRouteReady: isMeetingRealtimeRouteReady,
  isTalkBackMode: isMeetingTalkBackMode,
  ensureAudioBackend: ensureMeetingAudioBackend,
  resolveAudioRuntimeForFormat: resolveMeetingAudioRuntimeForFormat,
};
