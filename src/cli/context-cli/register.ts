import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { renderContextTreemapPng } from "../../auto-reply/reply/context-treemap.js";
import type { SessionSystemPromptReport } from "../../config/sessions/types.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import type { SessionUsageEntry } from "../../shared/usage-types.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { applyParentDefaultHelpAction } from "../program/parent-default-help.js";

type SessionsUsageResponse = {
  sessions?: SessionUsageEntry[];
};

async function fetchSessionReport(
  opts: GatewayRpcOpts,
  sessionKey: string | undefined,
): Promise<{ report: SessionSystemPromptReport; sessionKey: string } | null> {
  const params: Record<string, unknown> = { includeContextWeight: true, limit: 50 };
  if (sessionKey) {
    params.key = sessionKey;
    params.limit = 1;
  }
  const res = (await callGatewayFromCli("sessions.usage", opts, params)) as SessionsUsageResponse;
  const candidates = (res?.sessions ?? []).filter((s) => s.contextWeight != null);
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
      .option("--json", "Output result as JSON", false)
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
            defaultRuntime.error(danger(hint));
            defaultRuntime.exit(1);
            return;
          }

          const treemap = await renderContextTreemapPng({
            report: result.report,
            session: { cachedContextTokens: null, contextWindowTokens: null },
          });

          let finalPath = treemap.path;
          if (outputPath) {
            await copyFile(treemap.path, outputPath);
            finalPath = outputPath;
          }

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  path: finalPath,
                  sessionKey: result.sessionKey,
                  trackedChars: treemap.trackedChars,
                  caption: treemap.caption,
                },
                null,
                2,
              ),
            );
            return;
          }

          defaultRuntime.log(`${theme.success("Context treemap written to:")} ${finalPath}`);
          defaultRuntime.log(theme.muted(`Session: ${result.sessionKey}`));
          defaultRuntime.log(theme.muted(treemap.caption));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  applyParentDefaultHelpAction(context);
}
