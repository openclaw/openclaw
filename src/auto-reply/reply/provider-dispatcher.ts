// Dispatch adapters that bridge provider reply resolution into inbound dispatchers.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
} from "../dispatch.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "./provider-dispatcher.types.js";

export type {
  DispatchReplyWithBufferedBlockDispatcher,
  DispatchReplyWithDispatcher,
} from "./provider-dispatcher.types.js";

function resolveFleetLoopGuardChannel(ctx: unknown): string | null {
  const record = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
  const raw = String(
    readFleetLoopGuardPrimitive(record.Surface) ??
      readFleetLoopGuardPrimitive(record.Provider) ??
      readFleetLoopGuardPrimitive(record.OriginatingChannel) ??
      "",
  ).toLowerCase();
  return raw === "telegram" || raw === "imessage" || raw === "bluebubbles" ? raw : null;
}

function resolveFleetLoopGuardText(ctx: unknown): string {
  const record = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
  return String(
    readFleetLoopGuardPrimitive(record.BodyForAgent) ??
      readFleetLoopGuardPrimitive(record.CommandBody) ??
      readFleetLoopGuardPrimitive(record.RawBody) ??
      readFleetLoopGuardPrimitive(record.Body) ??
      "",
  )
    .replace(/\s+/g, " ")
    .trim();
}

function readFleetLoopGuardPrimitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function shouldSuppressFleetLoop(ctx: unknown): boolean {
  const channel = resolveFleetLoopGuardChannel(ctx);
  if (!channel) {
    return false;
  }
  const text = resolveFleetLoopGuardText(ctx);
  if (!text) {
    return false;
  }
  const record = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>) : {};
  const guardBin = process.env.FLEET_LOOP_GUARD_BIN || join(homedir(), "bin", "fleet-loop-guard");
  try {
    const stdout = execFileSync(guardBin, ["--check-json"], {
      input: JSON.stringify({
        bridge: channel,
        sessionKey: record.SessionKey,
        from: record.From,
        to: record.To ?? record.OriginatingTo,
        text,
        messageId: record.MessageSid,
      }),
      encoding: "utf8",
      timeout: Number(process.env.FLEET_LOOP_GUARD_TIMEOUT_MS || 1500),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout.trim() || "{}") as { suppress?: boolean };
    if (parsed.suppress === true) {
      console.warn(`[fleet-loop-guard] suppressed ${channel} loop`);
      return true;
    }
  } catch (error) {
    const maybeStatus = (error as { status?: number }).status;
    if (maybeStatus === 75) {
      console.warn(`[fleet-loop-guard] suppressed ${channel} loop`);
      return true;
    }
    console.warn(
      `[fleet-loop-guard] check failed for ${channel}; allowing dispatch: ${String(
        (error as { message?: unknown })?.message ?? error,
      )}`,
    );
  }
  return false;
}

const suppressedDispatchResult = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
};

/** Dispatch a reply using the buffered block dispatcher path. */
export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher =
  async (params) => {
    if (shouldSuppressFleetLoop(params.ctx)) {
      return suppressedDispatchResult;
    }
    return await dispatchInboundMessageWithBufferedDispatcher({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcherOptions: params.dispatcherOptions,
      replyResolver: params.replyResolver,
      replyOptions: params.replyOptions,
    });
  };

/** Dispatch a reply using the standard dispatcher path. */
export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = async (params) => {
  if (shouldSuppressFleetLoop(params.ctx)) {
    return suppressedDispatchResult;
  }
  return await dispatchInboundMessageWithDispatcher({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcherOptions: params.dispatcherOptions,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
};
