import crypto from "node:crypto";
import { cancel, isCancel } from "@clack/prompts";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { VERSION } from "../version.js";
import type { OnboardMode } from "./onboard-types.js";

export function guardCancel<T>(value: T | symbol, runtime: RuntimeEnv): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    runtime.exit(0);
    throw new Error("unreachable");
  }
  return value;
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function printWizardHeader(runtime: RuntimeEnv) {
  const header = [
    "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
    "██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██",
    "██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██",
    "██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██",
    "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    "                  🦞 OPENCLAW 🦞                    ",
    " ",
  ].join("\n");
  runtime.log(header);
}

export function applyWizardMetadata(
  cfg: OpenClawConfig,
  params: { command: string; mode: OnboardMode },
): OpenClawConfig {
  const commit = process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim() || undefined;
  return {
    ...cfg,
    wizard: {
      ...cfg.wizard,
      lastRunAt: new Date().toISOString(),
      lastRunVersion: VERSION,
      lastRunCommit: commit,
      lastRunCommand: params.command,
      lastRunMode: params.mode,
    },
  };
}
