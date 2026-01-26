/**
 * セッション永続化の型定義
 *
 * DynamoDBでθサイクルのセッション状態を永続化するための型
 */

import type { ThetaCycleState } from "../theta/types.js";

/**
 * セッションの状態
 */
export enum SessionStatus {
  /** 実行中 */
  RUNNING = "running",
  /** 一時停止中 */
  PAUSED = "paused",
  /** 完了 */
  COMPLETED = "completed",
  /** エラー停止 */
  ERROR = "error",
}

/**
 * セッションメタデータ
 */
export interface SessionMetadata {
  /** セッションID */
  sessionId: string;
  /** ユーザーID */
  userId?: string;
  /** チャンネルID */
  channelId?: string;
  /** ギルドID (Discord) */
  guildId?: string;
  /** 開始時刻 */
  startTime: number;
  /** 最終更新時刻 */
  lastUpdateTime: number;
  /** ステータス */
  status: SessionStatus;
  /** TTL (有効期限) - Unix timestamp */
  expiresAt: number;
}

/**
 * 保存されるセッション状態
 */
export interface PersistedSessionState {
  /** メタデータ */
  metadata: SessionMetadata;
  /** θサイクル状態 */
  thetaState: ThetaCycleState;
  /** 実行コンテキスト */
  context: Record<string, unknown>;
  /** エラー情報（ある場合） */
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

/**
 * セッション保存オプション
 */
export interface SaveStateOptions {
  /** TTL (秒), デフォルト: 1時間 */
  ttl?: number;
  /** エラー情報を含めるか */
  includeError?: boolean;
}

/**
 * 未完了セッションフィルタ
 */
export interface PendingSessionsFilter {
  /** ユーザーIDでフィルタ */
  userId?: string;
  /** チャンネルIDでフィルタ */
  channelId?: string;
  /** ギルドIDでフィルタ */
  guildId?: string;
  /** ステータスでフィルタ */
  status?: SessionStatus;
}

/**
 * セッション復元結果
 */
export interface RestoredSession {
  /** セッション状態 */
  state: PersistedSessionState;
  /** 継続可能か */
  resumable: boolean;
  /** 復元時の経過時間(ms) */
  elapsed: number;
}
