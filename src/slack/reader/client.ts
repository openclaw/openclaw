import type { SlackReaderConfig } from "./types.js";
import { createSlackWebClient } from "../client.js";

export const VALID_WORKSPACES = ["saasgroup", "protaige", "edubites", "zenloop"] as const;

export type ResolvedWorkspace = {
  id: string;
  name?: string;
  botToken: string;
};

export function resolveReaderWorkspaces(config: Partial<SlackReaderConfig>): ResolvedWorkspace[] {
  const workspaces = config.workspaces;
  if (!workspaces || typeof workspaces !== "object") {
    return [];
  }
  const result: ResolvedWorkspace[] = [];
  for (const [id, ws] of Object.entries(workspaces)) {
    if (ws.enabled === false) {
      continue;
    }
    const token = ws.botToken?.trim();
    if (!token) {
      continue;
    }
    result.push({ id, name: ws.name, botToken: token });
  }
  return result;
}

export function resolveReaderClient(workspace: string, config: Partial<SlackReaderConfig>) {
  const workspaces = config.workspaces;
  if (!workspaces || !(workspace in workspaces)) {
    const valid = workspaces ? Object.keys(workspaces).join(", ") : VALID_WORKSPACES.join(", ");
    throw new Error(`Unknown workspace '${workspace}'. Valid: ${valid}`);
  }
  const ws = workspaces[workspace];
  const token = ws?.botToken?.trim();
  if (!token) {
    throw new Error(`No bot token configured for workspace '${workspace}'`);
  }
  return createSlackWebClient(token);
}
