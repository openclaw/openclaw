import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildTuiAffinitySessionKey } from "../gateway/client-affinity.js";

const TUI_INSTANCE_DIR = path.join("tui", "instances");
const TUI_INSTANCE_SLOT_ENV_KEYS = [
  "OPENCLAW_TUI_SLOT",
  "TMUX_PANE",
  "WEZTERM_PANE",
  "TERM_SESSION_ID",
  "KITTY_WINDOW_ID",
  "ALACRITTY_WINDOW_ID",
  "WINDOWID",
] as const;

function sanitizeSlotKey(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 96);
  return normalized || "default";
}

export function resolveTuiInstanceSlot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of TUI_INSTANCE_SLOT_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      return `${key.toLowerCase()}:${value}`;
    }
  }
  return undefined;
}

export function resolveTuiInstanceFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const slot = resolveTuiInstanceSlot(env);
  const slotKey = sanitizeSlotKey(slot);
  return path.join(resolveStateDir(env), TUI_INSTANCE_DIR, `${slotKey}.json`);
}

export function loadOrCreateTuiInstanceId(params?: {
  env?: NodeJS.ProcessEnv;
  randomId?: () => string;
}): string {
  const env = params?.env ?? process.env;
  const override = env.OPENCLAW_TUI_INSTANCE_ID?.trim();
  if (override) {
    return override;
  }

  const filePath = resolveTuiInstanceFilePath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id.trim()) {
      return parsed.id.trim();
    }
  } catch {
    // Ignore missing/corrupt instance state and recreate it below.
  }

  const id = `tui-${(params?.randomId ?? crypto.randomUUID)()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        id,
        slot: resolveTuiInstanceSlot(env),
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return id;
}

export function resolveDefaultTuiSessionKey(params: {
  currentAgentId: string;
  sessionMainKey: string;
  clientInstanceId: string;
}): string {
  return buildTuiAffinitySessionKey({
    agentId: params.currentAgentId,
    mainKey: params.sessionMainKey,
    instanceId: params.clientInstanceId,
  });
}
