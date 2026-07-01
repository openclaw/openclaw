// Issues and redeems human-entered setup short codes for mobile onboarding.
import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { PluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import {
  resolvePairingSetupFromConfig,
  type PairingSetupPayload,
  type ResolvePairingSetupOptions,
} from "./setup-code.js";

const SETUP_SHORT_CODE_LENGTH = 8;
const SETUP_SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SETUP_SHORT_CODE_MAX_GENERATION_ATTEMPTS = 500;
const SETUP_SHORT_CODE_TTL_MS = 5 * 60 * 1000;
const SETUP_SHORT_CODE_MAX_ENTRIES = 200;
const SETUP_SHORT_CODE_NAMESPACE = "setup-short-codes";

type PairingSetupShortCodeRecord = {
  payload: PairingSetupPayload;
  issuedAtMs: number;
  expiresAtMs: number;
  authLabel: "token" | "password";
  urlSource: string;
};

export type PairingSetupShortCodeIssueResult =
  | {
      ok: true;
      code: string;
      expiresAtMs: number;
      authLabel: "token" | "password";
      urlSource: string;
    }
  | {
      ok: false;
      error: string;
    };

export type RegisterPairingSetupShortCodeOptions = {
  ttlMs?: number;
  codeGenerator?: () => string;
  store?: PairingSetupShortCodeStore;
};

export type PairingSetupShortCodeRedeemResult =
  | {
      ok: true;
      payload: PairingSetupPayload;
      expiresAtMs: number;
    }
  | {
      ok: false;
      reason: "invalid_or_expired";
    };

type PairingSetupShortCodeStore = PluginStateSyncKeyedStore<PairingSetupShortCodeRecord>;

export type IssuePairingSetupShortCodeOptions = ResolvePairingSetupOptions &
  RegisterPairingSetupShortCodeOptions;

export type RedeemPairingSetupShortCodeOptions = {
  nowMs?: number;
  store?: PairingSetupShortCodeStore;
};

function createSetupShortCodeStore(): PairingSetupShortCodeStore {
  return createCorePluginStateSyncKeyedStore<PairingSetupShortCodeRecord>({
    ownerId: "core:pairing",
    namespace: SETUP_SHORT_CODE_NAMESPACE,
    maxEntries: SETUP_SHORT_CODE_MAX_ENTRIES,
    defaultTtlMs: SETUP_SHORT_CODE_TTL_MS,
  });
}

export function normalizePairingSetupShortCodeInput(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .trim();
  if (normalized.length !== SETUP_SHORT_CODE_LENGTH) {
    return undefined;
  }
  for (const char of normalized) {
    if (!SETUP_SHORT_CODE_ALPHABET.includes(char)) {
      return undefined;
    }
  }
  return normalized;
}

export function formatPairingSetupShortCode(code: string): string {
  const normalized = normalizePairingSetupShortCodeInput(code);
  if (!normalized) {
    return code;
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function generatePairingSetupShortCode(): string {
  let out = "";
  for (let i = 0; i < SETUP_SHORT_CODE_LENGTH; i += 1) {
    const index = crypto.randomInt(0, SETUP_SHORT_CODE_ALPHABET.length);
    const char = SETUP_SHORT_CODE_ALPHABET[index];
    if (!char) {
      throw new Error("setup short-code alphabet lookup failed");
    }
    out += char;
  }
  return out;
}

function resolveTtlMs(value: number | undefined): number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= SETUP_SHORT_CODE_TTL_MS
  ) {
    return value;
  }
  return SETUP_SHORT_CODE_TTL_MS;
}

function registerUniqueShortCode(params: {
  store: PairingSetupShortCodeStore;
  record: PairingSetupShortCodeRecord;
  ttlMs: number;
  codeGenerator: () => string;
}): string {
  for (let attempt = 0; attempt < SETUP_SHORT_CODE_MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const code = normalizePairingSetupShortCodeInput(params.codeGenerator());
    if (!code) {
      continue;
    }
    if (params.store.registerIfAbsent(code, params.record, { ttlMs: params.ttlMs })) {
      return code;
    }
  }
  throw new Error(
    `failed to generate unique setup short code after ${SETUP_SHORT_CODE_MAX_GENERATION_ATTEMPTS} attempts`,
  );
}

export async function issuePairingSetupShortCode(
  cfg: OpenClawConfig,
  options: IssuePairingSetupShortCodeOptions = {},
): Promise<PairingSetupShortCodeIssueResult> {
  const resolved = await resolvePairingSetupFromConfig(cfg, options);
  if (!resolved.ok) {
    return resolved;
  }
  return registerPairingSetupShortCode(
    {
      payload: resolved.payload,
      authLabel: resolved.authLabel,
      urlSource: resolved.urlSource,
    },
    options,
  );
}

export function registerPairingSetupShortCode(
  setup: {
    payload: PairingSetupPayload;
    authLabel: "token" | "password";
    urlSource: string;
  },
  options: RegisterPairingSetupShortCodeOptions = {},
): PairingSetupShortCodeIssueResult {
  const nowMs = Date.now();
  const ttlMs = resolveTtlMs(options.ttlMs);
  const expiresAtMs = nowMs + ttlMs;
  const store = options.store ?? createSetupShortCodeStore();
  const code = registerUniqueShortCode({
    store,
    ttlMs,
    codeGenerator: options.codeGenerator ?? generatePairingSetupShortCode,
    record: {
      payload: setup.payload,
      issuedAtMs: nowMs,
      expiresAtMs,
      authLabel: setup.authLabel,
      urlSource: setup.urlSource,
    },
  });

  return {
    ok: true,
    code,
    expiresAtMs,
    authLabel: setup.authLabel,
    urlSource: setup.urlSource,
  };
}

export function redeemPairingSetupShortCode(
  rawCode: unknown,
  options: RedeemPairingSetupShortCodeOptions = {},
): PairingSetupShortCodeRedeemResult {
  const code = normalizePairingSetupShortCodeInput(rawCode);
  if (!code) {
    return { ok: false, reason: "invalid_or_expired" };
  }
  const store = options.store ?? createSetupShortCodeStore();
  const record = store.consume(code);
  const nowMs = options.nowMs ?? Date.now();
  if (!record || record.expiresAtMs <= nowMs) {
    return { ok: false, reason: "invalid_or_expired" };
  }
  return {
    ok: true,
    payload: record.payload,
    expiresAtMs: record.expiresAtMs,
  };
}
