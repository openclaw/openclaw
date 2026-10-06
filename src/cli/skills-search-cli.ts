import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import {
  CLAWHUB_SKILLS_SH_REF_PREFIX,
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  CLAWHUB_SKILLS_SH_TRUST_STATE,
} from "../infra/clawhub-skills.js";
import { defaultRuntime } from "../runtime.js";
import { searchSkillsFromClawHub } from "../skills/lifecycle/clawhub.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";
import { formatVersionLabel } from "./version-format.js";

function formatClawHubSearchText(value: string): string {
  return sanitizeForLog(value.replace(/\s+/gu, " ")).trim();
}

/** Register ClawHub skill search and its terminal/JSON output. */
export function registerSkillsSearchCli(skills: Command): void {
  skills
    .command("search")
    .description("Search ClawHub skills")
    .argument("[query...]", "Optional search query")
    .option("--limit <n>", "Max results", (value) => parseStrictPositiveIntOption(value, "--limit"))
    .option("--json", "Output as JSON", false)
    .action(async (queryParts: string[], opts: { limit?: number; json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const results = await searchSkillsFromClawHub({
          query: normalizeOptionalString(queryParts.join(" ")),
          limit: opts.limit,
        });
        if (opts.json || skills.opts<{ json?: boolean }>().json) {
          defaultRuntime.writeJson({ results });
          return;
        }
        if (results.length === 0) {
          defaultRuntime.log("No ClawHub skills found.");
          return;
        }
        for (const entry of results) {
          const installRef = normalizeOptionalString(entry.installRef);
          const skillRef = formatClawHubSearchText(installRef ?? entry.slug);
          const isExternalSource =
            installRef?.startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX) === true &&
            entry.trustState === CLAWHUB_SKILLS_SH_TRUST_STATE;
          const version = entry.version
            ? ` ${formatVersionLabel(formatClawHubSearchText(entry.version))}`
            : "";
          const summary = entry.summary ? `  ${formatClawHubSearchText(entry.summary)}` : "";
          const displayName = formatClawHubSearchText(entry.displayName);
          const trust = isExternalSource ? `  ${CLAWHUB_SKILLS_SH_TRUST_LABEL}` : "";
          defaultRuntime.log(`${skillRef}${version}  ${displayName}${summary}${trust}`);
        }
      });
    });
}
