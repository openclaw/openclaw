import type { CliDeps } from "../cli/deps.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";

export async function pollCommand(
  opts: {
    to: string;
    question: string;
    options: string[];
    selectableCount?: number;
    json?: boolean;
    dryRun?: boolean;
  },
  _deps: CliDeps,
  runtime: RuntimeEnv,
) {
  if (opts.options.length < 2) {
    throw new Error("Poll requires at least 2 options");
  }
  if (opts.options.length > 12) {
    throw new Error("Poll supports at most 12 options");
  }

  if (opts.dryRun) {
    runtime.log(
      `[dry-run] would send poll to ${opts.to}:\n  Question: ${opts.question}\n  Options: ${opts.options.join(", ")}\n  Selectable: ${opts.selectableCount ?? 1}`,
    );
    return;
  }

  const result = await callGateway<{
    messageId: string;
    toJid?: string;
  }>({
    url: "ws://127.0.0.1:18789",
    method: "poll",
    params: {
      to: opts.to,
      question: opts.question,
      options: opts.options,
      selectableCount: opts.selectableCount ?? 1,
      idempotencyKey: randomIdempotencyKey(),
    },
    timeoutMs: 10_000,
    clientName: "cli",
    mode: "cli",
  });

  runtime.log(
    success(
      `✅ Poll sent via gateway. Message ID: ${result.messageId ?? "unknown"}`,
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          provider: "whatsapp",
          via: "gateway",
          to: opts.to,
          toJid: result.toJid,
          messageId: result.messageId,
          question: opts.question,
          options: opts.options,
          selectableCount: opts.selectableCount ?? 1,
        },
        null,
        2,
      ),
    );
  }
}
