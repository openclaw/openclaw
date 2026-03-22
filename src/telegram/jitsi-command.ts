import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TelegramAccountConfig } from "../config/types.js";
import { loadJitsiBridgeDownstreamConfig } from "../jitsi-bridge/downstream-config.js";
import type { TelegramInlineButtons } from "./button-types.js";

type TelegramJitsiLabels = {
  createButton: string;
  joinButton: string;
  briefingButton: string;
  questionButton: string;
  refreshButton: string;
  clearButton: string;
  emptyPanelText: string;
  emptyPanelHint: string;
  pendingBriefingHint: string;
  pendingQuestionHint: string;
};

export type TelegramJitsiResolvedConfig = {
  enabled: boolean;
  bridgeUrl?: string;
  autoJoin: boolean;
  inviteEmail?: string;
  realtimeModel?: string;
  labels: TelegramJitsiLabels;
};

export type TelegramJitsiCommand =
  | { kind: "help" }
  | { kind: "start"; topic?: string }
  | { kind: "brief"; roomId?: string; briefing: string }
  | { kind: "ask"; roomId?: string; prompt: string }
  | { kind: "join"; roomId?: string }
  | { kind: "stop"; roomId?: string }
  | { kind: "status"; roomId?: string };

export type TelegramJitsiPendingAction = "briefing" | "question";

type TelegramJitsiRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
};

type JitsiRoom = {
  id: string;
  jitsiUrl: string;
  startUrl?: string;
  displayName: string;
  inviteEmail?: string;
  realtimeModel: string;
  briefing: string;
  status: string;
};

type JitsiRespondResult = {
  text: string;
  roomId: string;
  model: string;
};

type TelegramJitsiChatState = {
  activeRoomId?: string;
  pendingAction?: TelegramJitsiPendingAction;
};

type TelegramJitsiStateFile = {
  chats: Record<string, TelegramJitsiChatState>;
};

export type TelegramMeetPanel = {
  text: string;
  buttons: TelegramInlineButtons;
};

export type TelegramMeetCallbackAction =
  | { kind: "start" }
  | { kind: "status" }
  | { kind: "join" }
  | { kind: "prompt-briefing" }
  | { kind: "prompt-question" }
  | { kind: "refresh" }
  | { kind: "clear" };

const TELEGRAM_JITSI_CALLBACK_PREFIX = "jitsi:";
const jitsiDownstream = loadJitsiBridgeDownstreamConfig();

function resolveTelegramJitsiLabel(rawValue: unknown, fallback: string): string {
  return typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : fallback;
}

function resolveTelegramJitsiStateDir(): string {
  const explicit = process.env.OPENCLAW_TELEGRAM_JITSI_STATE_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(os.homedir(), ".openclaw", "telegram-jitsi");
}

function resolveTelegramJitsiStatePath(): string {
  return path.join(resolveTelegramJitsiStateDir(), "state.json");
}

async function loadTelegramJitsiState(): Promise<TelegramJitsiStateFile> {
  try {
    const raw = await fs.readFile(resolveTelegramJitsiStatePath(), "utf8");
    const parsed = JSON.parse(raw) as TelegramJitsiStateFile;
    return {
      chats: parsed && typeof parsed === "object" && parsed.chats ? parsed.chats : {},
    };
  } catch {
    return { chats: {} };
  }
}

async function updateTelegramJitsiState(
  stateKey: string,
  updater: (current: TelegramJitsiChatState) => TelegramJitsiChatState,
): Promise<TelegramJitsiChatState> {
  const stateDir = resolveTelegramJitsiStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  const nextState = await loadTelegramJitsiState();
  const updated = updater(nextState.chats[stateKey] ?? {});
  nextState.chats[stateKey] = updated;
  await fs.writeFile(resolveTelegramJitsiStatePath(), `${JSON.stringify(nextState, null, 2)}\n`);
  return updated;
}

async function readTelegramJitsiChatState(stateKey: string): Promise<TelegramJitsiChatState> {
  const state = await loadTelegramJitsiState();
  return state.chats[stateKey] ?? {};
}

export function buildTelegramJitsiStateKey(params: {
  chatId: string | number;
  threadId?: string | number;
}): string {
  return `chat:${params.chatId}:thread:${params.threadId ?? "main"}`;
}

export function resolveTelegramJitsiConfig(
  telegramCfg: TelegramAccountConfig,
): TelegramJitsiResolvedConfig {
  const jitsiCfg = telegramCfg.jitsi;
  const labels = jitsiCfg?.labels;
  const envBridgeUrl = process.env.OPENCLAW_TELEGRAM_JITSI_BRIDGE_URL?.trim();
  const bridgeUrl = jitsiCfg?.bridgeUrl?.trim() || envBridgeUrl || undefined;
  const enabled = jitsiCfg?.enabled === true || Boolean(bridgeUrl);
  return {
    enabled,
    bridgeUrl,
    autoJoin: jitsiCfg?.autoJoin !== false,
    inviteEmail: jitsiCfg?.inviteEmail?.trim() || undefined,
    realtimeModel: jitsiCfg?.realtimeModel?.trim() || undefined,
    labels: {
      createButton: resolveTelegramJitsiLabel(
        labels?.createButton,
        jitsiDownstream.telegramUi.createButton,
      ),
      joinButton: resolveTelegramJitsiLabel(
        labels?.joinButton,
        jitsiDownstream.telegramUi.joinButton,
      ),
      briefingButton: resolveTelegramJitsiLabel(
        labels?.briefingButton,
        jitsiDownstream.telegramUi.briefingButton,
      ),
      questionButton: resolveTelegramJitsiLabel(
        labels?.questionButton,
        jitsiDownstream.telegramUi.questionButton,
      ),
      refreshButton: resolveTelegramJitsiLabel(
        labels?.refreshButton,
        jitsiDownstream.telegramUi.refreshButton,
      ),
      clearButton: resolveTelegramJitsiLabel(
        labels?.clearButton,
        jitsiDownstream.telegramUi.clearButton,
      ),
      emptyPanelText: resolveTelegramJitsiLabel(
        labels?.emptyPanelText,
        jitsiDownstream.telegramUi.emptyPanelText,
      ),
      emptyPanelHint: resolveTelegramJitsiLabel(
        labels?.emptyPanelHint,
        jitsiDownstream.telegramUi.emptyPanelHint,
      ),
      pendingBriefingHint: resolveTelegramJitsiLabel(
        labels?.pendingBriefingHint,
        jitsiDownstream.telegramUi.pendingBriefingHint,
      ),
      pendingQuestionHint: resolveTelegramJitsiLabel(
        labels?.pendingQuestionHint,
        jitsiDownstream.telegramUi.pendingQuestionHint,
      ),
    },
  };
}

export function buildTelegramJitsiHelpText(): string {
  return [
    "Meeting control:",
    "/meet - show the control panel for the active meeting",
    "/meet <room_id> - join an existing room immediately",
    "/meet <topic> - create a new meeting immediately",
    "/meet stop - bot leaves active meeting and stops realtime",
    "/jitsi start <topic> - power-user fallback",
    "/jitsi brief <text> - add briefing to the active meeting",
    "/jitsi ask <text> - ask the active meeting persona a question",
  ].join("\n");
}

function looksLikeRoomId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/i.test(trimmed)) {
    return false;
  }
  // Room ids created by the bridge end with a UTC-like timestamp, e.g. ...-20260321113045.
  return /-\d{14}$/.test(trimmed);
}

function extractRoomIdFromMeetUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 1) {
      const candidate = decodeURIComponent(segments[0] || "").trim();
      return candidate && !/\s/.test(candidate) ? candidate : undefined;
    }
    if (segments.length >= 2 && segments[0] === "meeting") {
      const candidate = decodeURIComponent(segments[1] || "").trim();
      return candidate && !/\s/.test(candidate) ? candidate : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function parseTelegramJitsiCommand(rawText: string): TelegramJitsiCommand {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { kind: "help" };
  }
  const roomIdFromUrl = extractRoomIdFromMeetUrl(trimmed);
  if (roomIdFromUrl) {
    return { kind: "join", roomId: roomIdFromUrl };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "help" };
  }
  const [head, ...restParts] = trimmed.split(/\s+/);
  const rest = restParts.join(" ").trim();
  const subcommand = head.toLowerCase();
  if (subcommand === "start" || subcommand === "new" || subcommand === "create") {
    return { kind: "start", topic: rest || undefined };
  }
  if (subcommand === "brief") {
    return rest ? { kind: "brief", briefing: rest } : { kind: "help" };
  }
  if (subcommand === "ask") {
    return rest ? { kind: "ask", prompt: rest } : { kind: "help" };
  }
  if (subcommand === "join") {
    return { kind: "join", roomId: rest || undefined };
  }
  if (subcommand === "stop" || subcommand === "leave" || subcommand === "end") {
    return { kind: "stop", roomId: rest || undefined };
  }
  if (subcommand === "status" || subcommand === "show") {
    return { kind: "status", roomId: rest || undefined };
  }
  if (looksLikeRoomId(trimmed)) {
    return { kind: "join", roomId: trimmed };
  }
  return { kind: "start", topic: trimmed };
}

export function buildTelegramMeetButtons(
  hasActiveRoom: boolean,
  labels: TelegramJitsiLabels = resolveTelegramJitsiConfig({}).labels,
): TelegramInlineButtons {
  if (!hasActiveRoom) {
    return [
      [{ text: labels.createButton, callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}start` }],
    ];
  }
  return [
    [
      { text: "Status", callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}status` },
      { text: labels.joinButton, callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}join` },
    ],
    [
      {
        text: labels.briefingButton,
        callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}prompt-briefing`,
      },
      {
        text: labels.questionButton,
        callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}prompt-question`,
      },
    ],
    [
      { text: labels.refreshButton, callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}refresh` },
      { text: labels.clearButton, callback_data: `${TELEGRAM_JITSI_CALLBACK_PREFIX}clear` },
    ],
  ];
}

export function parseTelegramMeetCallback(data: string): TelegramMeetCallbackAction | null {
  if (!data.startsWith(TELEGRAM_JITSI_CALLBACK_PREFIX)) {
    return null;
  }
  const action = data.slice(TELEGRAM_JITSI_CALLBACK_PREFIX.length);
  switch (action) {
    case "start":
      return { kind: "start" };
    case "status":
      return { kind: "status" };
    case "join":
      return { kind: "join" };
    case "prompt-briefing":
      return { kind: "prompt-briefing" };
    case "prompt-question":
      return { kind: "prompt-question" };
    case "refresh":
      return { kind: "refresh" };
    case "clear":
      return { kind: "clear" };
    default:
      return null;
  }
}

async function requestBridge<T>(
  bridgeUrl: string,
  pathName: string,
  options: TelegramJitsiRequestOptions = {},
): Promise<T> {
  const url = new URL(pathName, bridgeUrl.endsWith("/") ? bridgeUrl : `${bridgeUrl}/`);
  const response = await fetch(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function ensureConfiguredBridgeUrl(config: TelegramJitsiResolvedConfig): Promise<string> {
  if (!config.enabled || !config.bridgeUrl) {
    throw new Error(
      "Jitsi bridge is not configured. Set channels.telegram.jitsi.bridgeUrl or OPENCLAW_TELEGRAM_JITSI_BRIDGE_URL.",
    );
  }
  return config.bridgeUrl;
}

function buildTimestampTopic(): string {
  return `Meeting ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
}

async function resolveActiveRoom(params: {
  config: TelegramJitsiResolvedConfig;
  stateKey: string;
}): Promise<JitsiRoom | null> {
  const bridgeUrl = await ensureConfiguredBridgeUrl(params.config);
  const state = await readTelegramJitsiChatState(params.stateKey);
  const activeRoomId = state.activeRoomId?.trim();
  if (!activeRoomId) {
    return null;
  }
  try {
    return await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${activeRoomId}`);
  } catch (error) {
    if (String(error).includes("Unknown room")) {
      await updateTelegramJitsiState(params.stateKey, (current) => ({
        ...current,
        activeRoomId: undefined,
        pendingAction: undefined,
      }));
      return null;
    }
    throw error;
  }
}

async function resolveRoomIdForCommand(params: {
  config: TelegramJitsiResolvedConfig;
  stateKey: string;
  roomId?: string;
}): Promise<string> {
  if (params.roomId?.trim()) {
    return params.roomId.trim();
  }
  const room = await resolveActiveRoom({
    config: params.config,
    stateKey: params.stateKey,
  });
  if (!room) {
    throw new Error("No active meeting in this chat. Use /meet first.");
  }
  return room.id;
}

function buildMeetPanelText(
  room: JitsiRoom | null,
  labels: TelegramJitsiLabels = resolveTelegramJitsiConfig({}).labels,
): string {
  if (!room) {
    return [labels.emptyPanelText, labels.emptyPanelHint].join("\n\n");
  }
  return [
    `Aktives Meeting: ${room.id}`,
    `Status: ${room.status}`,
    `Modell: ${room.realtimeModel}`,
    room.startUrl ? `Start-Link: ${room.startUrl}` : undefined,
    room.jitsiUrl,
    room.briefing
      ? `Briefing: ${room.briefing.slice(0, 180)}${room.briefing.length > 180 ? "…" : ""}`
      : "Briefing: noch keines gesetzt",
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

export async function buildTelegramMeetPanel(params: {
  config: TelegramJitsiResolvedConfig;
  stateKey: string;
}): Promise<TelegramMeetPanel> {
  const room = await resolveActiveRoom(params);
  return {
    text: buildMeetPanelText(room, params.config.labels),
    buttons: buildTelegramMeetButtons(Boolean(room), params.config.labels),
  };
}

async function createRoomForChat(params: {
  config: TelegramJitsiResolvedConfig;
  stateKey: string;
  topic?: string;
}): Promise<JitsiRoom> {
  const bridgeUrl = await ensureConfiguredBridgeUrl(params.config);
  const room = await requestBridge<JitsiRoom>(bridgeUrl, "/rooms", {
    body: {
      topic: params.topic?.trim() || buildTimestampTopic(),
      inviteEmail: params.config.inviteEmail,
      realtimeModel: params.config.realtimeModel,
    },
  });
  await updateTelegramJitsiState(params.stateKey, () => ({
    activeRoomId: room.id,
    pendingAction: undefined,
  }));
  if (params.config.autoJoin) {
    if (room.startUrl) {
      return room;
    }
    await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${room.id}/join`, {
      body: {},
    });
  }
  return room;
}

export async function handleTelegramMeetCallback(params: {
  config: TelegramJitsiResolvedConfig;
  stateKey: string;
  callback: TelegramMeetCallbackAction;
}): Promise<TelegramMeetPanel> {
  const { config, stateKey, callback } = params;
  const bridgeUrl = await ensureConfiguredBridgeUrl(config);
  switch (callback.kind) {
    case "start": {
      const room = await createRoomForChat({ config, stateKey });
      return {
        text: [
          `Meeting ${room.id} erstellt.`,
          room.startUrl ?? room.jitsiUrl,
          room.startUrl
            ? "Öffne den Start-Link und klicke Join. Dann joint der Bot automatisch."
            : config.autoJoin
              ? "Joiner wurde gestartet."
              : "Joiner wurde nicht automatisch gestartet.",
        ].join("\n"),
        buttons: buildTelegramMeetButtons(true, config.labels),
      };
    }
    case "status":
    case "refresh": {
      return await buildTelegramMeetPanel({ config, stateKey });
    }
    case "join": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey });
      const room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}/join`, {
        body: {},
      });
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: room.id,
        pendingAction: undefined,
      }));
      return {
        text: `Joiner wurde für ${room.id} gestartet.\n${room.jitsiUrl}`,
        buttons: buildTelegramMeetButtons(true, config.labels),
      };
    }
    case "prompt-briefing": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey });
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: roomId,
        pendingAction: "briefing",
      }));
      return {
        text: `Aktives Meeting: ${roomId}\n${config.labels.pendingBriefingHint}`,
        buttons: buildTelegramMeetButtons(true, config.labels),
      };
    }
    case "prompt-question": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey });
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: roomId,
        pendingAction: "question",
      }));
      return {
        text: `Aktives Meeting: ${roomId}\n${config.labels.pendingQuestionHint}`,
        buttons: buildTelegramMeetButtons(true, config.labels),
      };
    }
    case "clear": {
      await updateTelegramJitsiState(stateKey, () => ({
        activeRoomId: undefined,
        pendingAction: undefined,
      }));
      return {
        text: "Aktives Meeting für diesen Chat wurde entfernt.",
        buttons: buildTelegramMeetButtons(false, config.labels),
      };
    }
  }
}

export async function handleTelegramMeetPendingInput(params: {
  config: TelegramJitsiResolvedConfig;
  stateKey: string;
  text: string;
}): Promise<TelegramMeetPanel | null> {
  const bridgeUrl = await ensureConfiguredBridgeUrl(params.config);
  const state = await readTelegramJitsiChatState(params.stateKey);
  const pendingAction = state.pendingAction;
  const roomId = state.activeRoomId?.trim();
  const text = params.text.trim();
  if (!pendingAction || !roomId || !text) {
    return null;
  }
  await updateTelegramJitsiState(params.stateKey, (current) => ({
    ...current,
    pendingAction: undefined,
  }));
  if (pendingAction === "briefing") {
    const room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}/briefing`, {
      body: { briefing: text, append: true },
    });
    return {
      text: `Briefing für ${room.id} gespeichert.`,
      buttons: buildTelegramMeetButtons(true, params.config.labels),
    };
  }
  const result = await requestBridge<JitsiRespondResult>(bridgeUrl, `/rooms/${roomId}/respond`, {
    body: { prompt: text },
  });
  return {
    text: result.text || "Keine Antwort erzeugt.",
    buttons: buildTelegramMeetButtons(true, params.config.labels),
  };
}

export async function runTelegramJitsiCommand(params: {
  config: TelegramJitsiResolvedConfig;
  command: TelegramJitsiCommand;
  stateKey: string;
}): Promise<string> {
  const { config, command, stateKey } = params;
  const bridgeUrl = await ensureConfiguredBridgeUrl(config);
  switch (command.kind) {
    case "help":
      return buildTelegramJitsiHelpText();
    case "start": {
      const room = await createRoomForChat({
        config,
        stateKey,
        topic: command.topic,
      });
      return [
        `Meeting ${room.id} erstellt.`,
        room.startUrl ?? room.jitsiUrl,
        room.startUrl
          ? "Öffne den Start-Link und klicke Join. Dann joint der Bot automatisch."
          : config.autoJoin
            ? "Joiner gestartet."
            : "Joiner nicht automatisch gestartet.",
      ].join("\n");
    }
    case "brief": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey, roomId: command.roomId });
      const room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}/briefing`, {
        body: { briefing: command.briefing, append: true },
      });
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: room.id,
        pendingAction: undefined,
      }));
      return `Briefing für ${room.id} gespeichert.`;
    }
    case "ask": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey, roomId: command.roomId });
      const result = await requestBridge<JitsiRespondResult>(
        bridgeUrl,
        `/rooms/${roomId}/respond`,
        {
          body: { prompt: command.prompt },
        },
      );
      return result.text || "No response generated.";
    }
    case "join": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey, roomId: command.roomId });
      let room: JitsiRoom;
      try {
        room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}/join`, {
          body: {},
        });
      } catch (error) {
        const message = String(error);
        if (!message.includes(`Unknown room ${roomId}`)) {
          throw error;
        }
        await requestBridge<JitsiRoom>(bridgeUrl, "/rooms", {
          body: {
            id: roomId,
            topic: roomId,
            inviteEmail: config.inviteEmail,
            realtimeModel: config.realtimeModel,
          },
        });
        room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}/join`, {
          body: {},
        });
      }
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: room.id,
        pendingAction: undefined,
      }));
      return `Joiner gestartet für ${room.id}.`;
    }
    case "status": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey, roomId: command.roomId });
      const room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}`);
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: room.id,
        pendingAction: undefined,
      }));
      return buildMeetPanelText(room, config.labels);
    }
    case "stop": {
      const roomId = await resolveRoomIdForCommand({ config, stateKey, roomId: command.roomId });
      const room = await requestBridge<JitsiRoom>(bridgeUrl, `/rooms/${roomId}/stop`, {
        body: {},
      });
      await updateTelegramJitsiState(stateKey, (current) => ({
        ...current,
        activeRoomId: room.id,
        pendingAction: undefined,
      }));
      return `Meeting ${room.id} gestoppt. Bot hat den Raum verlassen und Realtime beendet.`;
    }
  }
}
