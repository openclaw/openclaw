import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { renderContextTreemapPng } from "../../auto-reply/reply/context-treemap.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { SessionUsageEntry } from "../../shared/usage-types.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { applyParentDefaultHelpAction } from "../program/parent-default-help.js";

type SessionsListResponse = {
  sessions?: SessionUsageEntry[];
};

async function fetchSessionReport(
  opts: GatewayRpcOpts,
  sessionKey: string | undefined,
): Promise<{ report: SessionSystemPromptReport; sessionKey: string } | null> {
  const params: Record<string, unknown> = {
    includeContextWeight: true,
    limit: sessionKey ? 1 : 50,
  };
  if (sessionKey) {
    params.key = sessionKey;
  }

  const res = (await callGatewayFromCli("sessions.list", opts, params)) as SessionsListResponse;
  const sessions = res?.sessions ?? [];

  // If no specific key requested, pick the most recently updated session with a report
  const candidates = sessions.filter((s) => s.contextWeight != null);
  if (candidates.length === 0) {
    return null;
  }

  const best = candidates.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!best?.contextWeight) {
    return null;
  }

  return { report: best.contextWeight, sessionKey: best.key };
}

export function registerContextCli(program: Command) {
  const context = program
    .command("context")
    .description("Inspect session context usage")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/concepts/context", "docs.openclaw.ai/concepts/context")}\n`,
    );

  addGatewayClientOptions(
    context
      .command("map")
      .description("Render a treemap PNG of the current session context contributors")
      .option("--session <key>", "Session key to inspect (defaults to most recently active)")
      .option("--output <path>", "Output path for the PNG (defaults to openclaw tmp dir)")
      .action(async (opts) => {
        const sessionKey: string | undefined =
          typeof opts.session === "string" && opts.session.trim() ? opts.session.trim() : undefined;
        const outputPath: string | undefined =
          typeof opts.output === "string" && opts.output.trim()
            ? path.resolve(opts.output.trim())
            : undefined;

        try {
          const result = await fetchSessionReport(opts, sessionKey);
          if (!result) {
            const hint = sessionKey
              ? `No context report found for session "${sessionKey}". Send a message first, then retry.`
              : "No context report found. Send a message in any session first, then retry.";
            console.error(theme.warn(hint));
            process.exitCode = 1;
            return;
          }

          const treemap = await renderContextTreemapPng({
            report: result.report,
            session: {
              cachedContextTokens: null,
              contextWindowTokens: null,
            },
          });

          let finalPath = treemap.path;
          if (outputPath) {
            await writeFile(outputPath, await readFile(treemap.path));
            finalPath = outputPath;
          }

          console.log(theme.success("Context treemap written to:"), finalPath);
          console.log(theme.muted(`Session: ${result.sessionKey}`));
          console.log(theme.muted(treemap.caption));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(theme.error(`context map failed: ${msg}`));
          process.exitCode = 1;
        }
      }),
  );

  applyParentDefaultHelpAction(context);
}
