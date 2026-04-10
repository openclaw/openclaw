/**
 * minimax-1008-guard — OpenClaw bundled hook
 *
 * MiniMax returns HTTP 500 {"type":"error","error":{"type":"api_error",
 * "message":"insufficient balance (1008)"}} both when the account has no
 * credits AND when the context window is exceeded.  OpenClaw currently
 * classifies this as a fatal billing error, which can cause the gateway to
 * hang (issue #24622).
 *
 * This hook:
 *  1. Detects the 1008 pattern on session:patch events
 *  2. Pushes a clear notification to the chat channel (front-end visible)
 *  3. Logs a structured warning to the gateway log (back-end visible)
 *  4. Checks context utilisation
 *  5. Issues /compact (or /new) so the session recovers automatically
 *  6. Never throws — keeps the gateway loop alive
 */

import type { HookHandler } from "../../hooks.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function is1008Error(msg: string | undefined): boolean {
  if (!msg) return false;
  return (
    msg.includes("1008") ||
    msg.toLowerCase().includes("insufficient balance") ||
    msg.toLowerCase().includes("billing error")
  );
}

function contextPct(sessionEntry: Record<string, unknown> | undefined): number {
  if (!sessionEntry) return 0;
  const limit =
    (sessionEntry.contextTokens as number) ??
    (sessionEntry.contextWindow as number) ??
    0;
  const used =
    (sessionEntry.currentContextTokens as number) ??
    ((sessionEntry.lastCallUsage as Record<string, number>)?.input ?? 0);
  if (limit <= 0 || used <= 0) return 0;
  return Math.round((used / limit) * 100);
}

// ── main handler ─────────────────────────────────────────────────────────────

const handler: HookHandler = async (event) => {
  try {
    if (event.type !== "session" || event.action !== "patch") return;

    const patch = event.context?.patch as Record<string, unknown> | undefined;
    const sessionEntry = event.context?.sessionEntry as Record<string, unknown> | undefined;

    const message = patch?.message as Record<string, unknown> | undefined;
    const stopReason = message?.stopReason as string | undefined;
    const errorMessage = message?.errorMessage as string | undefined;
    const provider = (message?.provider as string | undefined) ?? "";
    const model = (message?.model as string | undefined) ?? "";

    if (stopReason !== "error") return;
    if (!is1008Error(errorMessage)) return;

    // Read optional config
    const cfg = event.context?.cfg as Record<string, unknown> | undefined;
    const hookCfg = (
      (cfg?.hooks as Record<string, unknown>)?.internal as Record<string, unknown>
    )?.entries as Record<string, unknown> | undefined;
    const myConf = (hookCfg?.["minimax-1008-guard"] as Record<string, unknown>) ?? {};
    const thresholdPct = (myConf.contextThresholdPct as number) ?? 85;
    const autoAction = (myConf.autoAction as string) ?? "compact";

    // Compute context utilisation
    const pct = contextPct(sessionEntry);
    const isContextOverflow = pct >= thresholdPct;

    const providerLabel = provider
      ? `${provider}/${model}`.replace(/\/$/, "")
      : model || "MiniMax";

    // Back-end log
    console.warn(
      `[minimax-1008-guard] ⚠️  Caught 1008 error from ${providerLabel}` +
        ` | context ${pct > 0 ? pct + "%" : "unknown"}` +
        ` | isContextOverflow=${isContextOverflow}` +
        ` | sessionKey=${event.sessionKey}` +
        ` | rawError="${errorMessage}"`
    );

    // Front-end notification
    const contextNote =
      pct > 0
        ? `当前上下文使用率约 **${pct}%**。`
        : "无法读取当前上下文使用率。";

    const actionNote = isContextOverflow
      ? autoAction === "compact"
        ? "上下文已超阈值，正在自动执行 `/compact` 压缩历史记录…"
        : "上下文已超阈值，正在自动开启新会话 `/new`…"
      : "上下文使用率未超阈值，可能是账户余额不足，请检查 MiniMax 控制台。若余额充足，请手动执行 `/compact`。";

    event.messages.push(
      `⚠️ **MiniMax 返回了 1008 错误**（insufficient balance）\n\n` +
        `这通常不是真的欠费，而是本次请求的 token 数量超过了模型上下文窗口限制。\n\n` +
        `${contextNote}\n\n` +
        `${actionNote}\n\n` +
        `_Provider: \`${providerLabel}\` | Raw: \`${errorMessage ?? "1008"}\`_`
    );

    // Auto-recover
    if (isContextOverflow) {
      await new Promise((r) => setTimeout(r, 800));

      if (autoAction === "compact") {
        event.messages.push("/compact");
      } else {
        event.messages.push("/new");
      }

      console.log(
        `[minimax-1008-guard] ✅ Triggered auto-${autoAction} for session ${event.sessionKey}`
      );
    }
  } catch (err) {
    console.error("[minimax-1008-guard] Hook error (non-fatal):", err);
  }
};

export default handler;
