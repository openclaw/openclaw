import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import { getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { clawsRemovalJournalHandlers } from "./server-methods/claws-removal-journal.js";

type Observation = { stage: string; elapsedMs: number; nonce?: string };
let observation: { started: number; stages: Observation[] } | undefined;
const observedPorts = new WeakSet<MessagePort>();
// Observe transport messages without changing the original listener, decisions, or grants.
Object.defineProperty(MessagePort.prototype, "on", {
  configurable: true,
  writable: true,
  value(this: MessagePort, ...args: Parameters<MessagePort["on"]>) {
    if (args[0] === "message" && !observedPorts.has(this)) {
      observedPorts.add(this);
      MessagePort.prototype.addListener.call(this, "message", (message: unknown) => {
        if (!observation || !isRecord(message)) {
          return;
        }
        if (
          message.decision instanceof SharedArrayBuffer &&
          (message.stage === "transaction" || message.stage === "commit") &&
          isRecord(message.facts) &&
          typeof message.facts.nonce === "string"
        ) {
          observation.stages.push({
            stage: message.stage,
            nonce: message.facts.nonce,
            elapsedMs: performance.now() - observation.started,
          });
        } else if (message.kind === "native-commit" || message.kind === "native-settlement") {
          observation.stages.push({
            stage: message.kind,
            elapsedMs: performance.now() - observation.started,
          });
        }
      });
    }
    return MessagePort.prototype.addListener.apply(this, args);
  },
});

let current = true;
let active: Promise<void> | undefined;
process.on("disconnect", () => {
  current = false;
  void (async () => {
    try {
      await active;
    } finally {
      await closeOpenClawStateDatabaseAsync();
      process.exit(0);
    }
  })();
});
process.on("message", (message: unknown) => {
  if (
    !isRecord(message) ||
    typeof message.id !== "string" ||
    typeof message.stateDir !== "string" ||
    typeof message.configPath !== "string" ||
    typeof message.home !== "string" ||
    !isRecord(message.params)
  ) {
    throw new Error("Invalid synthetic journal transport request");
  }
  if (active) {
    throw new Error("Synthetic journal server only accepts one request at a time");
  }
  const request = {
    id: message.id,
    stateDir: message.stateDir,
    configPath: message.configPath,
    home: message.home,
    params: message.params,
  };
  active = (async () => {
    let response: { accepted: boolean; payload?: unknown; error?: ErrorShape } | undefined;
    const started = performance.now();
    const stages: Observation[] = [];
    observation = { started, stages };
    try {
      process.env.HOME = request.home;
      process.env.OPENCLAW_HOME = request.home;
      process.env.OPENCLAW_STATE_DIR = request.stateDir;
      process.env.OPENCLAW_CONFIG_PATH = request.configPath;
      delete process.env.OPENCLAW_AGENT_DIR;
      resetConfigRuntimeState();
      const config = getRuntimeConfig();
      await clawsRemovalJournalHandlers["claws.removalJournal"]({
        params: request.params,
        context: {
          getRuntimeConfig: () => config,
          cronStorePath: resolveCronJobsStorePathFromConfig(config),
          isConfigReloadSettled: () => true,
        },
        hasCurrentClientAuthority: () => current && process.connected,
        sessionMutationCommitGuard: () => {
          if (!current || !process.connected) {
            throw new Error("Synthetic caller disconnected");
          }
        },
        respond: (accepted, payload, error) => {
          response = { accepted, payload, error };
        },
      });
      await closeOpenClawStateDatabaseAsync();
      if (!response) {
        throw new Error("Journal handler returned no result");
      }
      process.send?.({
        id: request.id,
        ...response,
        stages,
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      process.send?.({
        id: request.id,
        harnessError: String(error),
        stages,
        elapsedMs: performance.now() - started,
      });
    } finally {
      observation = undefined;
      active = undefined;
    }
  })();
});
process.send?.({ ready: true });
