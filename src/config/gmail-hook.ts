import { asPositiveFiniteNumber } from "../../packages/normalization-core/src/number-coercion.js";
import type { HooksGmailTailscaleMode } from "./types.hooks.js";

export const DEFAULT_GMAIL_LABEL = "INBOX";
export const DEFAULT_GMAIL_TOPIC = "gog-gmail-watch";
export const DEFAULT_GMAIL_SUBSCRIPTION = "gog-gmail-watch-push";
export const DEFAULT_GMAIL_SERVE_BIND = "127.0.0.1";
export const DEFAULT_GMAIL_SERVE_PORT = 8788;
export const DEFAULT_GMAIL_SERVE_PATH = "/gmail-pubsub";
export const DEFAULT_GMAIL_MAX_BYTES = 20_000;
export const DEFAULT_GMAIL_RENEW_MINUTES = 12 * 60;

/** Resolve the per-message body byte bound gog is provisioned with (`--max-bytes`). */
export function resolveGmailHookMaxBytes(raw: number | undefined): number {
  return Math.floor(asPositiveFiniteNumber(raw) ?? DEFAULT_GMAIL_MAX_BYTES);
}

export type GmailHookOverrides = Partial<Omit<GmailHookRuntimeConfig, "serve" | "tailscale">> & {
  serveBind?: string;
  servePort?: number;
  servePath?: string;
  tailscaleMode?: HooksGmailTailscaleMode;
  tailscalePath?: string;
  tailscaleTarget?: string;
};

export type GmailHookRuntimeConfig = {
  account: string;
  label: string;
  topic: string;
  subscription: string;
  pushToken: string;
  hookToken: string;
  hookUrl: string;
  includeBody: boolean;
  maxBytes: number;
  renewEveryMinutes: number;
  serve: {
    bind: string;
    port: number;
    path: string;
  };
  tailscale: {
    mode: HooksGmailTailscaleMode;
    path: string;
    target?: string;
  };
};
