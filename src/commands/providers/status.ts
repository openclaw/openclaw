import { withProgress } from "../../cli/progress.js";
import { callGateway } from "../../gateway/call.js";
import { listChatProviders } from "../../providers/registry.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { type ChatProvider, formatProviderAccountLabel } from "./shared.js";

export type ProvidersStatusOptions = {
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

export function formatGatewayProvidersStatusLines(
  payload: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  lines.push(theme.success("Gateway reachable."));
  const accountLines = (
    provider: ChatProvider,
    accounts: Array<Record<string, unknown>>,
  ) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "enabled" : "disabled");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "configured" : "not configured");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "linked" : "not linked");
      }
      if (typeof account.running === "boolean") {
        bits.push(account.running ? "running" : "stopped");
      }
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (typeof account.botTokenSource === "string" && account.botTokenSource) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (typeof account.appTokenSource === "string" && account.appTokenSource) {
        bits.push(`app:${account.appTokenSource}`);
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const probe = account.probe as { ok?: boolean } | undefined;
      if (probe && typeof probe.ok === "boolean") {
        bits.push(probe.ok ? "works" : "probe failed");
      }
      const accountId =
        typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatProviderAccountLabel({
        provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const accountPayloads: Partial<
    Record<ChatProvider, Array<Record<string, unknown>>>
  > = {
    whatsapp: Array.isArray(payload.whatsappAccounts)
      ? (payload.whatsappAccounts as Array<Record<string, unknown>>)
      : undefined,
    telegram: Array.isArray(payload.telegramAccounts)
      ? (payload.telegramAccounts as Array<Record<string, unknown>>)
      : undefined,
    discord: Array.isArray(payload.discordAccounts)
      ? (payload.discordAccounts as Array<Record<string, unknown>>)
      : undefined,
    slack: Array.isArray(payload.slackAccounts)
      ? (payload.slackAccounts as Array<Record<string, unknown>>)
      : undefined,
    signal: Array.isArray(payload.signalAccounts)
      ? (payload.signalAccounts as Array<Record<string, unknown>>)
      : undefined,
    imessage: Array.isArray(payload.imessageAccounts)
      ? (payload.imessageAccounts as Array<Record<string, unknown>>)
      : undefined,
  };

  for (const meta of listChatProviders()) {
    const accounts = accountPayloads[meta.id];
    if (accounts && accounts.length > 0) {
      lines.push(...accountLines(meta.id, accounts));
    }
  }

  lines.push("");
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} runs local probes without a gateway.`,
  );
  return lines;
}

export async function providersStatusCommand(
  opts: ProvidersStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const timeoutMs = Number(opts.timeout ?? 10_000);
  try {
    const payload = await withProgress(
      {
        label: "Checking provider status…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "providers.status",
          params: { probe: Boolean(opts.probe), timeoutMs },
          timeoutMs,
        }),
    );
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }
    runtime.log(
      formatGatewayProvidersStatusLines(
        payload as Record<string, unknown>,
      ).join("\n"),
    );
  } catch (err) {
    runtime.error(`Gateway not reachable: ${String(err)}`);
    runtime.exit(1);
  }
}
