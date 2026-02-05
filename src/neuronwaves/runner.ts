import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { NeuronWaveTraceEntry, NeuronWavesConfig } from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveNeuronWavesConfigFromEnv } from "./config.js";
import { tryPostGhPrComment } from "./reporters/github-gh.js";
import { appendNeuronWaveTrace, loadNeuronWavesState, saveNeuronWavesState } from "./state.js";

const log = createSubsystemLogger("neuronwaves");

export type NeuronWavesRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
};

function randInt(maxExclusive: number) {
  return Math.floor(Math.random() * Math.max(0, maxExclusive));
}

function computeNextRunAt(nowMs: number, cfg: NeuronWavesConfig) {
  const jitter = cfg.jitterMs > 0 ? randInt(cfg.jitterMs) : 0;
  return nowMs + cfg.baseIntervalMs + jitter;
}

function resolveLastActivityAtMs(cfg: OpenClawConfig, agentId: string): number {
  // Best-effort heuristic: use session store updatedAt for main session.
  const sessionCfg = cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const mainKey = resolveAgentMainSessionKey({ cfg, agentId });
  const entry = store[mainKey];
  return entry?.updatedAt ?? 0;
}

export function startNeuronWavesRunner(opts: { cfg: OpenClawConfig }): NeuronWavesRunner {
  const state = {
    cfg: opts.cfg,
    timer: null as NodeJS.Timeout | null,
    stopped: false,
  };

  const schedule = (delayMs: number) => {
    if (state.stopped) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void tick(), Math.max(1_000, delayMs));
    state.timer.unref?.();
  };

  const tick = async () => {
    const nwCfg = resolveNeuronWavesConfigFromEnv();
    const agentId = resolveDefaultAgentId(state.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(state.cfg, agentId);

    if (!nwCfg.enabled) {
      schedule(60_000);
      return;
    }

    const nowMs = Date.now();
    const lastActivityAtMs = resolveLastActivityAtMs(state.cfg, agentId);
    const inactivityMs = lastActivityAtMs ? nowMs - lastActivityAtMs : Number.POSITIVE_INFINITY;

    const persisted = await loadNeuronWavesState(workspaceDir);
    const due = persisted.nextRunAtMs <= 0 || nowMs >= persisted.nextRunAtMs;

    if (inactivityMs < nwCfg.inactivityMs) {
      // user active recently; check again later
      const nextDelay = Math.min(5 * 60_000, nwCfg.baseIntervalMs);
      await appendNeuronWaveTrace(workspaceDir, {
        atMs: nowMs,
        agentId,
        status: "skipped",
        reason: "active",
        inactivityMs,
        nextRunAtMs: persisted.nextRunAtMs,
      } satisfies NeuronWaveTraceEntry);
      schedule(nextDelay);
      return;
    }

    if (!due) {
      schedule(Math.max(5_000, persisted.nextRunAtMs - nowMs));
      return;
    }

    const nextRunAtMs = computeNextRunAt(nowMs, nwCfg);
    await saveNeuronWavesState(workspaceDir, { nextRunAtMs });

    // MVP wave: record a trace + optionally post a PR comment.
    const trace: NeuronWaveTraceEntry = {
      atMs: nowMs,
      agentId,
      status: "ran",
      reason: "due",
      inactivityMs,
      nextRunAtMs,
      notes:
        "NeuronWave tick ran (MVP). This version records traces and can post PR comments; future versions will add task planning + safe execution.",
      decisions: [
        {
          title: "MVP tick",
          why: "NeuronWaves enabled, user inactive, and nextRunAt reached.",
          risk: "low",
          action: { kind: "noop", reason: "MVP wave does not execute tasks yet." },
        },
      ],
    };

    await appendNeuronWaveTrace(workspaceDir, trace);

    if (nwCfg.postPrComments && nwCfg.pr) {
      const body =
        "NeuronWave tick (MVP)\n\n" +
        `- agent: ${agentId}\n` +
        `- inactivity: ${Math.round(inactivityMs / 1000)}s\n` +
        `- next run: ${new Date(nextRunAtMs).toISOString()}\n` +
        "\nNext: implement planner + safe actions + CoreMemories ingestion.";

      const res = await tryPostGhPrComment({
        repo: nwCfg.pr.repo,
        prNumber: nwCfg.pr.number,
        body,
      });
      if (!res.ok) {
        log.debug(`pr comment skipped: ${res.reason}`);
      }
    }

    schedule(nwCfg.baseIntervalMs);
  };

  const updateConfig = (cfg: OpenClawConfig) => {
    state.cfg = cfg;
  };

  // start quickly; tick will decide whether to run
  schedule(5_000);

  const stop = () => {
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  };

  return { stop, updateConfig };
}
