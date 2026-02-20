import type { AgentMessage } from "@mariozechner/pi-agent-core";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestBatchResult,
  IngestResult,
} from "../types.js";
import type { DoltRecord, DoltRecordLevel, DoltStore } from "./store/types.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { registerContextEngine } from "../registry.js";
import { assembleDoltContext, writeDoltContextSnapshot } from "./assembly.js";
import { hydrateDoltBootstrapState } from "./bootstrap.js";
import { enforceDoltBindleOldestFirstEviction } from "./eviction.js";
import {
  evaluateDoltLanePressure,
  resolveDoltLanePolicies,
  selectDoltTurnChunkForCompaction,
  type DoltLanePolicies,
} from "./policy.js";
import { finalizeDoltReset } from "./reset-finalization.js";
import { executeDoltRollup } from "./rollup.js";
import { openSqliteDoltStore } from "./store/sqlite-dolt-store.js";

type DoltContextEngineOptions = {
  agentId?: string;
};

type DoltCompactionCycleResult = {
  compacted: boolean;
  bindleCreated: boolean;
};

/**
 * Built-in Dolt context engine registration target.
 *
 * This engine is intentionally isolated from the legacy bridge path so selecting
 * `contextEngine: "dolt"` never silently routes through legacy compaction.
 */
export class DoltContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "dolt",
    name: "Dolt Context Engine",
    version: "0.1.0",
    ownsCompaction: true,
  };

  private store: DoltStore | null = null;
  private readonly config?: OpenClawConfig;
  private readonly options?: DoltContextEngineOptions;
  private readonly turnPointerCounters = new Map<string, number>();
  private turnDrainMode = false;
  private leafDrainMode = false;

  constructor(config?: OpenClawConfig, options?: DoltContextEngineOptions) {
    this.config = config;
    this.options = options;
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    const store = this.ensureStore();
    const bootstrap = await store.bootstrapFromJsonl({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
    });
    if (!bootstrap.bootstrapped) {
      return {
        bootstrapped: false,
        reason: bootstrap.reason,
      };
    }

    hydrateDoltBootstrapState({
      store,
      sessionId: params.sessionId,
      tokenBudget: this.resolveBootstrapTokenBudget(),
    });
    return {
      bootstrapped: true,
      importedMessages: bootstrap.importedRecords,
    };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const store = this.ensureStore();
    const eventTsMs = Date.now();
    const pointer = this.buildTurnPointer(params.sessionId, eventTsMs);
    const payload = {
      role: resolveMessageRole(params.message),
      content: resolveMessageContent(params.message),
    };

    store.upsertRecord({
      pointer,
      sessionId: params.sessionId,
      level: "turn",
      eventTsMs,
      payload,
    });
    store.upsertActiveLane({
      sessionId: params.sessionId,
      level: "turn",
      pointer,
      isActive: true,
      lastEventTsMs: eventTsMs,
    });
    return { ingested: true };
  }

  async ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    for (const message of params.messages) {
      await this.ingest({
        sessionId: params.sessionId,
        message,
        isHeartbeat: params.isHeartbeat,
      });
    }
    return { ingestedCount: params.messages.length };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    const store = this.ensureStore();
    const newMessages = params.messages.slice(Math.max(0, params.prePromptMessageCount));
    if (newMessages.length > 0) {
      await this.ingestBatch({
        sessionId: params.sessionId,
        messages: newMessages,
        isHeartbeat: params.isHeartbeat,
      });
    }
    await this.runCompactionCycle({
      store,
      sessionId: params.sessionId,
      lanePolicies: resolveDoltLanePolicies(),
    });
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const store = this.ensureStore();
    if (store.countSessionRecords(params.sessionId) === 0) {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }

    const assembled = assembleDoltContext({
      store,
      sessionId: params.sessionId,
      tokenBudget: params.tokenBudget,
    });

    // Write an atomic snapshot file alongside the DB for live inspection.
    try {
      const snapshotPath = this.resolveDbPath().replace(/\.db$/, ".context.json");
      writeDoltContextSnapshot({
        result: assembled,
        sessionId: params.sessionId,
        snapshotPath,
      });
    } catch {
      // Snapshot is best-effort — never block context assembly.
    }

    return {
      messages: assembled.messages,
      estimatedTokens: assembled.estimatedTokens,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
  }): Promise<CompactResult> {
    const store = this.ensureStore();
    const compaction = await this.runCompactionCycle({
      store,
      sessionId: params.sessionId,
      lanePolicies: resolveDoltLanePolicies(),
    });
    if (!compaction.compacted) {
      return {
        ok: true,
        compacted: false,
        reason: "no_pressure",
      };
    }
    return {
      ok: true,
      compacted: true,
    };
  }

  async beforeSessionReset(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    reason: "new" | "reset";
  }): Promise<void> {
    const store = this.ensureStore();
    await finalizeDoltReset({
      store,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config: this.config,
    });
  }

  async dispose(): Promise<void> {
    if (!this.store) {
      return;
    }
    this.store.close();
    this.store = null;
    this.turnPointerCounters.clear();
    this.turnDrainMode = false;
    this.leafDrainMode = false;
  }

  private ensureStore(): DoltStore {
    if (this.store) {
      return this.store;
    }
    this.store = openSqliteDoltStore({
      dbPath: this.resolveDbPath(),
    });
    return this.store;
  }

  private resolveDbPath(): string {
    const agentId = normalizeOptionalString(this.options?.agentId);
    if (!agentId) {
      return path.join(resolveStateDir(), "dolt.db");
    }
    const normalizedAgentId = normalizeAgentId(agentId);
    const agentRoot = this.config
      ? path.dirname(resolveAgentDir(this.config, normalizedAgentId))
      : path.join(resolveStateDir(), "agents", normalizedAgentId);
    return path.join(agentRoot, "dolt.db");
  }

  private buildTurnPointer(sessionId: string, eventTsMs: number): string {
    const key = `${sessionId}:${eventTsMs}`;
    const next = (this.turnPointerCounters.get(key) ?? 0) + 1;
    this.turnPointerCounters.set(key, next);
    return `turn:${sessionId}:${eventTsMs}:${next}`;
  }

  private resolveBootstrapTokenBudget(): number {
    const policies = resolveDoltLanePolicies();
    return policies.bindle.target + policies.leaf.target + policies.turn.target;
  }

  private async runCompactionCycle(params: {
    store: DoltStore;
    sessionId: string;
    lanePolicies: DoltLanePolicies;
  }): Promise<DoltCompactionCycleResult> {
    let compacted = false;
    let bindleCreated = false;

    const turnCompacted = await this.compactTurnLane(params);
    compacted = compacted || turnCompacted;

    const bindleCompacted = await this.compactLeafLane(params);
    compacted = compacted || bindleCompacted;
    bindleCreated = bindleCreated || bindleCompacted;

    if (bindleCreated) {
      enforceDoltBindleOldestFirstEviction({
        store: params.store,
        sessionId: params.sessionId,
        targetTokens: params.lanePolicies.bindle.target,
      });
    }

    return { compacted, bindleCreated };
  }

  private async compactTurnLane(params: {
    store: DoltStore;
    sessionId: string;
    lanePolicies: DoltLanePolicies;
  }): Promise<boolean> {
    const turnRecords = this.listActiveLaneRecords(params.store, params.sessionId, "turn");
    const laneTokenCount = sumRecordTokens(turnRecords);
    const pressure = evaluateDoltLanePressure({
      laneTokenCount,
      policy: params.lanePolicies.turn,
      drainMode: this.turnDrainMode,
    });
    this.turnDrainMode = pressure.nextDrainMode;
    if (!pressure.shouldCompact || turnRecords.length === 0) {
      return false;
    }

    const selection = selectDoltTurnChunkForCompaction({
      turns: turnRecords.map((turn) => ({
        pointer: turn.pointer,
        tokenCount: turn.tokenCount,
      })),
      laneTokenCount,
      policy: params.lanePolicies.turn,
    });
    if (selection.selected.length === 0) {
      return false;
    }

    const selectedPointers = new Set(selection.selected.map((entry) => entry.pointer));
    const selectedRecords = turnRecords.filter((record) => selectedPointers.has(record.pointer));
    if (selectedRecords.length === 0) {
      return false;
    }

    await executeDoltRollup({
      store: params.store,
      sessionId: params.sessionId,
      targetLevel: "leaf",
      sourceRecords: selectedRecords,
      config: this.config,
    });
    return true;
  }

  private async compactLeafLane(params: {
    store: DoltStore;
    sessionId: string;
    lanePolicies: DoltLanePolicies;
  }): Promise<boolean> {
    const leafRecords = this.listActiveLaneRecords(params.store, params.sessionId, "leaf");
    const laneTokenCount = sumRecordTokens(leafRecords);
    const pressure = evaluateDoltLanePressure({
      laneTokenCount,
      policy: params.lanePolicies.leaf,
      drainMode: this.leafDrainMode,
    });
    this.leafDrainMode = pressure.nextDrainMode;
    if (!pressure.shouldCompact || leafRecords.length < 2) {
      return false;
    }

    const selected = selectLeafChunkForCompaction({
      records: leafRecords,
      pressureDelta: pressure.pressureDelta,
    });
    if (selected.length < 2) {
      return false;
    }

    await executeDoltRollup({
      store: params.store,
      sessionId: params.sessionId,
      targetLevel: "bindle",
      sourceRecords: selected,
      config: this.config,
    });
    return true;
  }

  private listActiveLaneRecords(
    store: DoltStore,
    sessionId: string,
    level: DoltRecordLevel,
  ): DoltRecord[] {
    return store
      .listActiveLane({
        sessionId,
        level,
        activeOnly: true,
      })
      .map((entry) => store.getRecord(entry.pointer))
      .filter((record): record is DoltRecord => {
        return !!record && record.sessionId === sessionId && record.level === level;
      })
      .toSorted((a, b) => a.eventTsMs - b.eventTsMs || a.pointer.localeCompare(b.pointer));
  }
}

/** Register the built-in Dolt context engine factory. */
export function registerDoltContextEngine(): void {
  registerContextEngine("dolt", (config, options) => new DoltContextEngine(config, options));
}

function sumRecordTokens(records: DoltRecord[]): number {
  return records.reduce((sum, record) => sum + normalizeNonNegativeInt(record.tokenCount), 0);
}

function selectLeafChunkForCompaction(params: {
  records: DoltRecord[];
  pressureDelta: number;
}): DoltRecord[] {
  const selected: DoltRecord[] = [];
  let selectedTokens = 0;
  for (const record of params.records) {
    selected.push(record);
    selectedTokens += normalizeNonNegativeInt(record.tokenCount);
    if (selected.length >= 2 && selectedTokens >= params.pressureDelta) {
      break;
    }
  }
  if (selected.length < 2) {
    return [];
  }
  return selected;
}

function resolveMessageRole(message: AgentMessage): string {
  const role = (message as { role?: unknown }).role;
  if (typeof role === "string" && role.trim()) {
    return role;
  }
  return "assistant";
}

function resolveMessageContent(message: AgentMessage): unknown {
  const content = (message as { content?: unknown }).content;
  if (content === undefined) {
    return "";
  }
  return content;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNonNegativeInt(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}
