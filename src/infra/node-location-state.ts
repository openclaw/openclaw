import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type NodeLocationState = {
  lat: number;
  lon: number;
  accuracyMeters?: number;
  timestamp: string;
  nodeId?: string;
  source?: string;
};

const LOCATION_STATE_FILENAME = "node-location-state.json";

export function resolveLocationStatePath(stateDir?: string): string {
  const dir = stateDir ?? resolveStateDir();
  return path.join(dir, LOCATION_STATE_FILENAME);
}

export async function readNodeLocationState(stateDir?: string): Promise<NodeLocationState | null> {
  const filePath = resolveLocationStatePath(stateDir);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.lat !== "number" || typeof obj.lon !== "number") {
      return null;
    }
    return {
      lat: obj.lat,
      lon: obj.lon,
      accuracyMeters: typeof obj.accuracyMeters === "number" ? obj.accuracyMeters : undefined,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString(),
      nodeId: typeof obj.nodeId === "string" ? obj.nodeId : undefined,
      source: typeof obj.source === "string" ? obj.source : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeNodeLocationState(
  state: NodeLocationState,
  stateDir?: string,
): Promise<void> {
  const filePath = resolveLocationStatePath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}
