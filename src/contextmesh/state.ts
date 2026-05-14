import os from "node:os";
import path from "node:path";
import { defaultContextMeshState } from "./defaults.js";
import {
  loadContextMeshStateFromSqlite,
  saveContextMeshStateToSqlite,
} from "./store.sqlite.js";
import type { ContextMeshState } from "./types.js";

export { defaultContextMeshState };

export function resolveContextMeshDir(): string {
  const home = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  return path.join(home, ".openclaw", "contextmesh");
}

export function resolveContextMeshStatePath(): string {
  return path.join(resolveContextMeshDir(), "state.json");
}

export async function loadContextMeshState(): Promise<ContextMeshState> {
  try {
    return loadContextMeshStateFromSqlite();
  } catch {
    return defaultContextMeshState();
  }
}

export async function saveContextMeshState(state: ContextMeshState): Promise<void> {
  saveContextMeshStateToSqlite(state);
}
