import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuntimeState } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(goalId: string): RuntimeState {
  return {
    goalId,
    lastDeliveryByIdempotencyKey: {},
    seenSignalKeys: {},
    updatedAt: nowIso(),
  };
}

export class RuntimeStore {
  private readonly stateFile: string;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
  }

  async load(goalId: string): Promise<RuntimeState> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as RuntimeState;
      return {
        ...defaultState(goalId),
        ...parsed,
        goalId,
      };
    } catch {
      return defaultState(goalId);
    }
  }

  async save(state: RuntimeState): Promise<void> {
    const next: RuntimeState = {
      ...state,
      updatedAt: nowIso(),
    };
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  async recordDelivery(
    goalId: string,
    idempotencyKey: string,
    delivered: boolean,
    transport: string,
  ): Promise<void> {
    const state = await this.load(goalId);
    state.lastDeliveryByIdempotencyKey[idempotencyKey] = {
      delivered,
      transport,
      at: nowIso(),
    };
    state.lastActivityAt = nowIso();
    await this.save(state);
  }

  async touchActivity(goalId: string): Promise<void> {
    const state = await this.load(goalId);
    state.lastActivityAt = nowIso();
    await this.save(state);
  }

  async getLastActivityAt(goalId: string): Promise<string | undefined> {
    const state = await this.load(goalId);
    return state.lastActivityAt;
  }

  async getLastNudgeAt(goalId: string): Promise<string | undefined> {
    const state = await this.load(goalId);
    return state.lastNudgeAt;
  }

  async markNudgeSent(goalId: string): Promise<void> {
    const state = await this.load(goalId);
    state.lastNudgeAt = nowIso();
    await this.save(state);
  }

  async hasSeenSignal(goalId: string, dedupeKey: string): Promise<boolean> {
    const state = await this.load(goalId);
    return Boolean(state.seenSignalKeys[dedupeKey]);
  }

  async markSignalSeen(goalId: string, dedupeKey: string): Promise<void> {
    const state = await this.load(goalId);
    state.seenSignalKeys[dedupeKey] = nowIso();
    await this.save(state);
  }
}
