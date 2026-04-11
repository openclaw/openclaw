/**
 * JSON file-based fallback store for task flow registry when node:sqlite is unavailable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistryJsonPath,
} from "./task-flow-registry.paths.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

const log = createSubsystemLogger("tasks/flow-registry");

const FLOW_REGISTRY_DIR_MODE = 0o700;
const FLOW_REGISTRY_FILE_MODE = 0o600;

let inMemoryFlows: Map<string, TaskFlowRecord> = new Map();
let jsonPath: string | null = null;

function getJsonPath(): string {
  if (!jsonPath) {
    jsonPath = resolveTaskFlowRegistryJsonPath(process.env);
  }
  return jsonPath;
}

function ensureDirectory() {
  const dir = resolveTaskFlowRegistryDir(process.env);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: FLOW_REGISTRY_DIR_MODE });
  }
}

function writeJsonFile(flows: Map<string, TaskFlowRecord>) {
  const path = getJsonPath();
  ensureDirectory();
  const data = {
    flows: Array.from(flows.values()),
    version: 1,
    updatedAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: FLOW_REGISTRY_FILE_MODE });
}

function readJsonFile(): { flows: TaskFlowRecord[] } | null {
  const path = getJsonPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);
    return {
      flows: data.flows || [],
    };
  } catch (err) {
    log("warn", "Failed to read task flow registry JSON file, starting fresh:", err);
    return null;
  }
}

export function loadTaskFlowRegistryStateFromJson(): TaskFlowRegistryStoreSnapshot {
  const data = readJsonFile();
  if (data) {
    inMemoryFlows = new Map(data.flows.map((f) => [f.flowId, f]));
    log("info", `Loaded ${inMemoryFlows.size} flows from JSON store (node:sqlite unavailable)`);
  } else {
    inMemoryFlows = new Map();
    log("info", "Starting with empty task flow registry (JSON store, node:sqlite unavailable)");
  }
  return {
    flows: new Map(inMemoryFlows),
  };
}

export function saveTaskFlowRegistryStateToJson(snapshot: TaskFlowRegistryStoreSnapshot) {
  inMemoryFlows = new Map(snapshot.flows);
  writeJsonFile(inMemoryFlows);
}

export function upsertTaskFlowRecordToJson(flow: TaskFlowRecord) {
  inMemoryFlows.set(flow.flowId, flow);
  writeJsonFile(inMemoryFlows);
}

export function deleteTaskFlowRecordFromJson(flowId: string) {
  inMemoryFlows.delete(flowId);
  writeJsonFile(inMemoryFlows);
}

export function closeTaskFlowRegistryJsonStore() {
  writeJsonFile(inMemoryFlows);
  inMemoryFlows = new Map();
  jsonPath = null;
}
