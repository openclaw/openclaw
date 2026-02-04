/**
 * AFO Kingdom Multi-Agent Orchestra Types
 *
 * 6개의 독립 LLM 봇 - 삼국지 스타일 명명
 * 만덕이가 오케스트레이터로 조율
 */

export type BotRole = "orchestrator" | "agent";

export type BotId = "mandeok" | "jarong" | "gwanwoo" | "youngdeok" | "jangbi" | "soondeok";

export type BackendType =
  | "openclaw"
  | "claude-code"
  | "opencode"
  | "ollama"
  | "antigravity"
  | "cline";

export interface BotConfig {
  id: BotId;
  name: string;
  nameKor: string;
  role: BotRole;
  telegramUsername: string;
  telegramToken: string;
  port: number;
  backend: BackendType;
  envPrefix: string;
  description: string;
}

export interface OrchestraConfig {
  bots: Record<BotId, BotConfig>;
  groupChatId: string;
  eventBus: {
    type: "redis" | "memory";
    channel: string;
  };
  orchestrator: BotId;
}

// ─────────────────────────────────────────────────────────────────────────────
// 봇 정의 (삼국지 + 한국 스타일)
// ─────────────────────────────────────────────────────────────────────────────

export const BOT_PORTS: Record<BotId, number> = {
  mandeok: 18789,
  jarong: 18790,
  gwanwoo: 18791,
  youngdeok: 18792,
  jangbi: 18793,
  soondeok: 18794,
} as const;

export const BOT_NAMES: Record<BotId, string> = {
  mandeok: "만덕이",
  jarong: "자룡",
  gwanwoo: "관우",
  youngdeok: "영덕",
  jangbi: "장비",
  soondeok: "순덕",
} as const;

export const BOT_BACKENDS: Record<BotId, BackendType> = {
  mandeok: "openclaw",
  jarong: "claude-code",
  gwanwoo: "opencode",
  youngdeok: "ollama",
  jangbi: "antigravity",
  soondeok: "cline",
} as const;

export const BOT_DESCRIPTIONS: Record<BotId, string> = {
  mandeok: "오케스트레이터 - OpenClaw Gateway",
  jarong: "조자룡처럼 믿음직한 - Claude Code",
  gwanwoo: "의리의 관우 - OpenCode",
  youngdeok: "로컬 LLM 영웅 - Ollama",
  jangbi: "장비의 호쾌함 - Antigravity/Gemini",
  soondeok: "순한 덕, 섬세한 - Cline/Cursor",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 이벤트 타입
// ─────────────────────────────────────────────────────────────────────────────

export type OrchestraEventType =
  | "message" // 일반 메시지
  | "mention" // @멘션
  | "request_opinion" // 의견 요청 (오케스트레이터 → 에이전트)
  | "broadcast" // 전체 브로드캐스트
  | "response" // 응답
  | "health_check" // 헬스체크
  | "health_response"; // 헬스체크 응답

export interface OrchestraEvent {
  id: string;
  type: OrchestraEventType;
  from: BotId;
  to: BotId | "all";
  payload: {
    chatId: number;
    messageId?: number;
    text: string;
    replyTo?: number;
    context?: Record<string, unknown>;
  };
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 토론 세션
// ─────────────────────────────────────────────────────────────────────────────

export interface DiscussionSession {
  id: string;
  chatId: number;
  topic: string;
  initiator: BotId;
  participants: BotId[];
  messages: DiscussionMessage[];
  status: "active" | "completed" | "timeout";
  startedAt: number;
  endedAt?: number;
}

export interface DiscussionMessage {
  from: BotId;
  text: string;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 오케스트레이터 명령
// ─────────────────────────────────────────────────────────────────────────────

export type OrchestratorCommand =
  | { type: "request_opinion"; target: BotId; topic: string }
  | { type: "broadcast"; message: string }
  | { type: "summarize"; sessionId: string }
  | { type: "delegate"; target: BotId; task: string }
  | { type: "health_check" }
  | { type: "roll_call" }; // 점호!

// ─────────────────────────────────────────────────────────────────────────────
// 환경변수 키
// ─────────────────────────────────────────────────────────────────────────────

export const BOT_TOKEN_ENV_KEYS: Record<BotId, string> = {
  mandeok: "MANDEOK_TELEGRAM_TOKEN",
  jarong: "JARONG_TELEGRAM_TOKEN",
  gwanwoo: "GWANWOO_TELEGRAM_TOKEN",
  youngdeok: "YOUNGDEOK_TELEGRAM_TOKEN",
  jangbi: "JANGBI_TELEGRAM_TOKEN",
  soondeok: "SOONDEOK_TELEGRAM_TOKEN",
} as const;
