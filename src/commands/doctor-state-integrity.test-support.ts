import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { readAgentRosterProperty } from "../agents/agent-roster.js";
import type { OpenClawConfig } from "../config/config.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import {
  resolveSessionStorePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { noteStateIntegrity as noteStateIntegrityRaw } from "./doctor-state-integrity.js";

export const noteMock = vi.fn();

export function withMainAgentRoster(
  cfg: OpenClawConfigWithLegacyRoster,
): OpenClawConfigWithLegacyRoster {
  if (readAgentRosterProperty(cfg)) {
    return cfg;
  }
  return {
    ...cfg,
    agents: { ...cfg.agents, entries: { main: {} } },
  };
}

export async function noteStateIntegrity(
  cfg: OpenClawConfigWithLegacyRoster,
  prompter: Parameters<typeof noteStateIntegrityRaw>[1],
  configPath?: string,
) {
  return noteStateIntegrityRaw(withMainAgentRoster(cfg), prompter, configPath);
}

export function setupSessionState(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  agentId = "main",
) {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, () => homeDir);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
}

export function stateIntegrityText(): string {
  return noteMock.mock.calls
    .filter((call) => call[1] === "State integrity")
    .map((call) => String(call[0]))
    .join("\n");
}

export function doctorChangesText(): string {
  return noteMock.mock.calls
    .filter((call) => call[1] === "Doctor changes")
    .map((call) => String(call[0]))
    .join("\n");
}

export type RuntimeRepairPrompt = {
  initialValue?: boolean;
  message?: string;
  requiresInteractiveConfirmation?: boolean;
};

export function repairPromptCalls(confirmRuntimeRepair: {
  mock: { calls: unknown[][] };
}): RuntimeRepairPrompt[] {
  return confirmRuntimeRepair.mock.calls.map((call) => call[0] as RuntimeRepairPrompt);
}

export function hasRepairPromptMessage(
  confirmRuntimeRepair: { mock: { calls: unknown[][] } },
  text: string,
): boolean {
  return repairPromptCalls(confirmRuntimeRepair).some((prompt) => prompt.message?.includes(text));
}

export function writeSessionStore(
  cfg: OpenClawConfig,
  sessions: Record<string, { sessionId: string; updatedAt: number } & Record<string, unknown>>,
  agentId = "main",
) {
  openOpenClawStateDatabase({ env: process.env });
  setupSessionState(cfg, process.env, process.env.HOME ?? "", agentId);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
}

export async function runStateIntegrityText(cfg: OpenClawConfigWithLegacyRoster): Promise<string> {
  await noteStateIntegrity(withMainAgentRoster(cfg), {
    confirmRuntimeRepair: vi.fn(async () => false),
    note: noteMock,
  });
  return stateIntegrityText();
}
