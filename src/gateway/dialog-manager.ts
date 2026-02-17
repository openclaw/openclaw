import { DialogSession } from "../dialog/session.js";
import type { DialogStep } from "../dialog/types.js";

export class DialogManager {
  private sessions = new Map<string, DialogSession>();
  /** Maps sessionKey -> dialogId for quick lookup. */
  private sessionKeyIndex = new Map<string, string>();

  create(params: {
    sessionKey: string;
    steps: DialogStep[];
    expiresInMs?: number;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
    intro?: string;
    outro?: string;
  }): DialogSession {
    const existing = this.sessionKeyIndex.get(params.sessionKey);
    if (existing) {
      const session = this.sessions.get(existing);
      if (session && session.getStatus() === "running") {
        throw new Error("dialog already active for this session");
      }
      // Clean up finished dialog
      this.sessions.delete(existing);
      this.sessionKeyIndex.delete(params.sessionKey);
    }
    const session = new DialogSession(params);
    this.sessions.set(session.dialogId, session);
    this.sessionKeyIndex.set(params.sessionKey, session.dialogId);
    return session;
  }

  get(dialogId: string): DialogSession | null {
    const session = this.sessions.get(dialogId);
    if (!session) {
      return null;
    }
    const status = session.getStatus();
    if (status !== "running") {
      this.sessions.delete(dialogId);
      this.sessionKeyIndex.delete(session.getState().sessionKey);
      return null;
    }
    return session;
  }

  getBySessionKey(sessionKey: string): DialogSession | null {
    const dialogId = this.sessionKeyIndex.get(sessionKey);
    if (!dialogId) {
      return null;
    }
    const session = this.sessions.get(dialogId);
    if (!session) {
      this.sessionKeyIndex.delete(sessionKey);
      return null;
    }
    // Auto-clean expired/finished sessions
    const status = session.getStatus();
    if (status !== "running") {
      this.sessions.delete(dialogId);
      this.sessionKeyIndex.delete(sessionKey);
      return null;
    }
    return session;
  }

  cancel(dialogId: string): boolean {
    const session = this.sessions.get(dialogId);
    if (!session) {
      return false;
    }
    session.cancel();
    const state = session.getState();
    this.sessions.delete(dialogId);
    this.sessionKeyIndex.delete(state.sessionKey);
    return true;
  }

  purge(dialogId: string): void {
    const session = this.sessions.get(dialogId);
    if (!session) {
      return;
    }
    const state = session.getState();
    this.sessions.delete(dialogId);
    this.sessionKeyIndex.delete(state.sessionKey);
  }
}
