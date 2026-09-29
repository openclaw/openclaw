import { z } from "zod";
import { formatErrorMessage } from "../infra/errors.js";
import { ensureMeetingAudioBackend, resolveMeetingAudioRuntimeForFormat } from "./audio-backend.js";
import {
  createMeetingChromeTransport,
  createMeetingChromeTransportWithExternalAudio,
} from "./chrome-transport.js";
import { createMeetingConfiguredNodeHost } from "./configured-node-host.js";
import { isMeetingRealtimeRouteReady, isMeetingTalkBackMode } from "./meeting-modes.js";
import { normalizeMeetingObservationProvenance } from "./observation-provenance.js";
import type {
  MeetingBrowserAdapter,
  MeetingBrowserLeaveStep,
  MeetingManualActionCategory,
  MeetingPlatformAdapter as MeetingPlatformAdapterContract,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import { registerMeetingPluginCli } from "./plugin-cli.js";
import { createMeetingPluginConfigSchema } from "./plugin-config.js";
import { createMeetingPluginEntryOptions } from "./plugin-entry.js";
import {
  createMeetingChromeRuntimeBindings,
  createMeetingPluginChromeTransport,
  createMeetingPluginNodeHostHandler,
  createMeetingPluginNodeInvokePolicy,
  createMeetingPluginShellEntry,
  createMeetingPluginTypes,
} from "./plugin-shell.js";
import { createMeetingRuntimeFacade } from "./runtime-facade.js";
import { createMeetingRuntimeProbes, resolveMeetingProbeTimeoutMs } from "./runtime-probes.js";
import { createMeetingRuntimeSetup } from "./runtime-setup.js";
import type {
  MeetingBrowserHealth,
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "./session-types.js";
import { createMeetingStatusCallSource } from "./status-call-source.js";
import { createMeetingStatusPreludeSource } from "./status-prejoin-source.js";

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

type MeetingPlatformAdapterOptions<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
> = Omit<
  MeetingPlatformAdapter<
    Session,
    Mode,
    Health,
    Transcript,
    CreateParams,
    CreateResult,
    DialInParams,
    DialInPlan
  >,
  "agentConsult" | "browser" | "session"
> & {
  agentConsult: MeetingPlatformRuntimeMetadata["agentConsult"];
  browser: Omit<
    MeetingBrowserAdapter<Mode, Health, Transcript>,
    "captions" | "classifyManualAction" | "parseLeaveResult" | "parseStatus" | "permissionNotes"
  > & {
    captions: Omit<MeetingBrowserAdapter<Mode, Health, Transcript>["captions"], "parseTranscript">;
    permissionNotes?: MeetingBrowserAdapter<Mode, Health, Transcript>["permissionNotes"];
  };
  parsing: {
    classifyManualActionReason(reason: string): MeetingManualActionCategory;
    displayName: string;
    invalidTranscriptMessage: string;
    malformedStatusMessage: string;
    malformedTranscriptMessage: string;
    statusFields?(parsed: Record<string, unknown>): Partial<Health>;
  };
  session: MeetingPlatformRuntimeMetadata["session"];
};

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
const invalidBrowserArrayItemSchema = z.unknown().transform(() => null);
const meetingCaptionSourceSchema = z.object({
  id: z.string().min(1).max(512),
  epoch: z.string().min(1).max(512),
  revision: z.string().min(1).max(128),
  finalized: z.boolean(),
  ownEcho: z.boolean().optional(),
});
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
  .array(z.union([meetingTranscriptLineSchema, invalidBrowserArrayItemSchema]))
  .transform((lines) => lines.filter((line) => line !== null));

const meetingCaptionLinesSchema = z
  .array(
    z.union([
      meetingTranscriptLineSchema.and(z.object({ source: z.unknown().optional() })),
      invalidBrowserArrayItemSchema,
    ]),
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
    .array(z.union([z.string(), invalidBrowserArrayItemSchema]))
    .transform((notes) => notes.filter((note) => note !== null))
    .optional()
    .catch(undefined),
});

function parseMeetingBrowserStatus<Health extends MeetingBrowserHealth>(
  result: unknown,
  adapterId: string,
  options: MeetingPlatformAdapterOptions<
    never,
    string,
    Health,
    MeetingTranscriptSnapshot
  >["parsing"],
): Health | undefined {
  const raw = browserResultString(result);
  if (!raw) {
    return undefined;
  }
  let parsed: z.infer<typeof meetingBrowserStatusSchema>;
  try {
    parsed = meetingBrowserStatusSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(options.malformedStatusMessage);
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
    ...options.statusFields?.(parsed),
  } as unknown as Health;
}

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

function parseMeetingTranscript<Transcript extends MeetingTranscriptSnapshot>(
  result: unknown,
  adapterId: string,
  options: MeetingPlatformAdapterOptions<
    never,
    string,
    MeetingBrowserHealth,
    Transcript
  >["parsing"],
): Transcript & { sessionMatched?: boolean; urlMatched?: boolean } {
  const raw = browserResultString(result);
  if (!raw) {
    return { droppedLines: 0, lines: [] } as unknown as Transcript;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(options.malformedTranscriptMessage);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(options.invalidTranscriptMessage);
  }
  const payload = parsed as {
    droppedLines?: unknown;
    epoch?: unknown;
    lines?: unknown;
    pendingLines?: unknown;
    sessionMatched?: unknown;
    urlMatched?: unknown;
  };
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
          transcriptLine.provenance = normalizeMeetingObservationProvenance(line.provenance, {
            observer: adapterId,
            epoch: payload.epoch,
            observedAt: line.at,
            speaker: line.speaker,
          });
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
      parseStatus: (result) => parseMeetingBrowserStatus(result, options.id, parsing),
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
        parseTranscript: (result) => parseMeetingTranscript(result, options.id, parsing),
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
  createChromeTransport: createMeetingChromeTransport,
  createChromeTransportWithExternalAudio: createMeetingChromeTransportWithExternalAudio,
  createChromeRuntimeBindings: createMeetingChromeRuntimeBindings,
  createPluginChromeTransport: createMeetingPluginChromeTransport,
  createPluginConfigSchema: createMeetingPluginConfigSchema,
  createPluginNodeHostHandler: createMeetingPluginNodeHostHandler,
  createPluginNodeInvokePolicy: createMeetingPluginNodeInvokePolicy,
  createPluginShellEntry: createMeetingPluginShellEntry,
  createRuntimeFacade: createMeetingRuntimeFacade,
  createRuntimeSetup: createMeetingRuntimeSetup,
  pluginTypes: createMeetingPluginTypes,
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
