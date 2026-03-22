import path from "node:path";
import type { JitsiBridgeDownstreamConfig } from "./downstream-config.js";
import { loadJitsiBridgeDownstreamConfig } from "./downstream-config.js";

export type JitsiBridgeConfig = {
  host: string;
  port: number;
  stateDir: string;
  publicBaseUrl?: string;
  jitsiBaseUrl: string;
  inviteEmail?: string;
  displayName: string;
  realtimeBaseUrl: string;
  realtimeApiKey: string;
  realtimeModel: string;
  browserExecutablePath?: string;
  downstream: JitsiBridgeDownstreamConfig;
};

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable ${name}: ${raw}`);
  }
  return parsed;
}

export function loadJitsiBridgeConfig(): JitsiBridgeConfig {
  const cwd = process.cwd();
  const downstream = loadJitsiBridgeDownstreamConfig();
  return {
    host: process.env.JITSI_BRIDGE_HOST?.trim() || "127.0.0.1",
    port: readNumberEnv("JITSI_BRIDGE_PORT", 4318),
    stateDir:
      process.env.JITSI_BRIDGE_STATE_DIR?.trim() ||
      path.join(cwd, ".artifacts", "jitsi-realtime-bridge"),
    publicBaseUrl: process.env.JITSI_BRIDGE_PUBLIC_BASE_URL?.trim() || undefined,
    jitsiBaseUrl: process.env.JITSI_BASE_URL?.trim() || "https://meet.jit.si",
    inviteEmail: process.env.JITSI_INVITE_EMAIL?.trim() || downstream.identity.inviteEmail,
    displayName: process.env.JITSI_BOT_DISPLAY_NAME?.trim() || downstream.identity.displayName,
    realtimeBaseUrl: readRequiredEnv("AZURE_OPENAI_REALTIME_BASE_URL"),
    realtimeApiKey: readRequiredEnv("AZURE_OPENAI_API_KEY"),
    realtimeModel: process.env.AZURE_OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-mini",
    browserExecutablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
    downstream,
  };
}
