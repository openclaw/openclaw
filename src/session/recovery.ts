/**
 * セッションリカバリユーティリティ
 *
 * Fly.io/Lambda再起動時に未完了セッションを検出・再開する
 */

import type { PersistedSessionState, PendingSessionsFilter } from "./types.js";
import { getPendingSessions, updateStatus, updateStatusIf, deleteSession } from "./manager.js";
import { SessionStatus } from "./types.js";

/**
 * リカバリオプション
 */
export interface RecoveryOptions {
  /** ユーザーIDでフィルタ */
  userId?: string;
  /** ギルドIDでフィルタ */
  guildId?: string;
  /** チャンネルIDでフィルタ */
  channelId?: string;
  /** 最大復元数 */
  maxSessions?: number;
  /** タイムアウト(ms) */
  timeout?: number;
}

/**
 * リカバリ結果
 */
export interface RecoveryResult {
  /** 復元されたセッション */
  sessions: PersistedSessionState[];
  /** スキップされたセッション数 */
  skipped: number;
  /** 削除された期限切れセッション数 */
  expired: number;
}

/**
 * 再起動時に未完了セッションを復元
 *
 * Fly.io/Lambda起動時に呼び出し、中断していたθサイクルを再開する。
 *
 * @param options - リカバリオプション
 * @param onRestore - セッション復元時のコールバック
 * @returns リカバリ結果
 */
export async function recoverPendingSessions(
  options: RecoveryOptions = {},
  onRestore?: (session: PersistedSessionState) => void | Promise<void>,
): Promise<RecoveryResult> {
  const { userId, guildId, channelId, maxSessions = 100, timeout = 30000 } = options;

  const filter: PendingSessionsFilter = {
    userId,
    guildId,
    channelId,
    status: SessionStatus.RUNNING,
  };

  const startTime = Date.now();
  const sessions = await getPendingSessions(filter);
  const result: RecoveryResult = {
    sessions: [],
    skipped: 0,
    expired: 0,
  };

  // 期限切れチェック
  const validSessions = sessions.filter((s) => {
    if (Date.now() > s.metadata.expiresAt * 1000) {
      deleteSession(s.metadata.sessionId);
      result.expired++;
      return false;
    }
    return true;
  });

  // 最大数制限
  const toRestore = validSessions.slice(0, maxSessions);

  for (const session of toRestore) {
    // タイムアウトチェック
    if (Date.now() - startTime > timeout) {
      result.skipped += validSessions.length - toRestore.indexOf(session);
      break;
    }

    try {
      // P1-5修正: 条件付き更新（現在のステータスがRUNNINGの場合のみ）
      // 他のリカバリプロセスが既に処理していた場合はスキップ
      const updated = await updateStatusIf(
        session.metadata.sessionId,
        SessionStatus.PAUSED,
        SessionStatus.RUNNING,
      );

      if (!updated) {
        console.log(
          `[Recovery] Session ${session.metadata.sessionId} already being recovered by another process`,
        );
        result.skipped++;
        continue;
      }

      // コールバック実行
      if (onRestore) {
        await onRestore(session);
      }

      result.sessions.push(session);
    } catch (error) {
      console.error(`[Recovery] Failed to restore session ${session.metadata.sessionId}:`, error);
      result.skipped++;
    }
  }

  result.skipped += validSessions.length - toRestore.length - result.skipped;

  return result;
}

/**
 * セッションのハートビート更新
 *
 * 定期的に呼び出し、TTL延長と生存確認を行う。
 *
 * @param sessionId - セッションID
 * @param ttl - 新しいTTL (秒), デフォルト: 1時間
 */
export async function heartbeatSession(sessionId: string, ttl: number = 3600): Promise<void> {
  const _expiresAt = Math.floor(Date.now() / 1000) + ttl;

  // TODO: UpdateItemでexpiresAtを更新
  // 現状のupdateStatus()はlastUpdateTimeのみ更新
  // 必要に応じてmanager.tsにupdateExpiresAt()を追加
}

/**
 * セッションを完了状態にする
 *
 * θサイクル完了時に呼び出す。
 *
 * @param sessionId - セッションID
 * @param finalState - 最終状態（オプション）
 */
export async function completeSession(
  sessionId: string,
  finalState?: Partial<PersistedSessionState>,
): Promise<void> {
  await updateStatus(sessionId, SessionStatus.COMPLETED);

  // 必要に応じて最終状態を保存
  if (finalState) {
    // TODO: finalStateをマージして保存
  }

  // TTLを短く設定して早期削除（オプション）
  // 完了セッションは24時間後に削除
  // const expiresAt = Math.floor(Date.now() / 1000) + 86400;
  // await updateExpiresAt(sessionId, expiresAt);
}

/**
 * セッションをエラー状態にする
 *
 * θサイクルエラー時に呼び出す。
 *
 * @param sessionId - セッションID
 * @param error - エラー情報
 */
export async function failSession(sessionId: string, _error: Error): Promise<void> {
  await updateStatus(sessionId, SessionStatus.ERROR);

  // エラー情報を記録
  // TODO: エラーをstate.errorに保存して更新
}
