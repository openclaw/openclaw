import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { maybeRecoverSuspiciousConfigRead } from "./io.observe-recovery.js";
import { createSnapshot } from "./mutate.test-support.js";

type ObserveRecoveryDeps = Parameters<typeof maybeRecoverSuspiciousConfigRead>[0]["deps"];

export const approveRecoveryCandidate = <T extends { raw: string; parsed: unknown }>(
  candidate: T,
) => ({
  ok: true as const,
  candidate,
});

export function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

export function createRecoveryConfigEnv(
  home: string,
  configPath: string,
  stateDir: string,
  env: NodeJS.ProcessEnv = {},
) {
  env.HOME ??= home;
  env.USERPROFILE ??= home;
  env.OPENCLAW_CONFIG_PATH ??= configPath;
  env.OPENCLAW_STATE_DIR ??= stateDir;
  env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ??= "1";
  env.VITEST ??= "true";
  return env;
}

export async function writeConfigRaw(configPath: string, config: Record<string, unknown>) {
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  await fs.promises.writeFile(configPath, raw, "utf-8");
  return { raw, parsed: config };
}

export async function seedConfig(configPath: string, config: Record<string, unknown>) {
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  return writeConfigRaw(configPath, config);
}

export async function makeSnapshot(configPath: string, config: Record<string, unknown>) {
  const { raw } = await seedConfig(configPath, config);
  return {
    ...createSnapshot({ path: configPath, sourceConfig: config, raw }),
    raw,
    parsed: config,
  };
}

export function makeDeps(
  home: string,
  warn = vi.fn(),
): { deps: ObserveRecoveryDeps; configPath: string; auditPath: string; warn: typeof warn } {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  return {
    deps: { fs, env: {}, homedir: () => home, logger: { warn } },
    configPath,
    auditPath: path.join(home, ".openclaw", "logs", "config-audit.jsonl"),
    warn,
  };
}

export const clobberedUpdateChannelConfig = { update: { channel: "beta" } };
export const clobberedUpdateChannelRaw = `${JSON.stringify(clobberedUpdateChannelConfig, null, 2)}\n`;
export const recoverableTelegramConfig = {
  meta: { lastTouchedVersion: "2026.4.22" },
  update: { channel: "beta" },
  gateway: { mode: "local" },
  channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
};
export const recoverableCoreConfig = {
  meta: { lastTouchedVersion: "2026.4.22" },
  update: { channel: "beta" },
  gateway: { mode: "local" as const },
};
export const largeRecoverableCoreConfig = {
  ...recoverableCoreConfig,
  gateway: {
    ...recoverableCoreConfig.gateway,
    trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
  },
};

export function createRecoveryBaselineConfig() {
  return {
    meta: { lastTouchedVersion: "2026.4.22" },
    gateway: {
      mode: "local" as const,
      trustedProxies: Array.from({ length: 40 }, (_, index) => `192.0.2.${index}`),
    },
  };
}
