import fs from "node:fs/promises";
import os from "node:os";
import { resolveConfigAuditLogPath, scrubConfigAuditLog } from "../config/io.audit.js";
import { note } from "../terminal/note.js";

const NOTE_TITLE = "Config audit";

type ConfigAuditScrubFs = Parameters<typeof scrubConfigAuditLog>[0]["fs"];

export type ConfigAuditScrubIssue = {
  readonly auditPath: string;
  readonly scanned: number;
  readonly rewritten: number;
  readonly skipped: number;
  readonly message: string;
  readonly fixHint: string;
};

export type ConfigAuditScrubRepairResult = {
  readonly auditPath: string;
  readonly scanned: number;
  readonly rewritten: number;
  readonly skipped: number;
  readonly aborted: boolean;
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
};

function formatEntryCount(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

function formatConfigAuditScrubMessage(count: number): string {
  return `${formatEntryCount(count)} in config-audit.jsonl still contain pre-redactor argv values (likely plaintext credentials at rest).`;
}

function formatConfigAuditScrubFixHint(fixCommand = "openclaw doctor --fix"): string {
  return `Run \`${fixCommand}\` to rewrite the argv/execArgv fields through the same redactor used for new entries.`;
}

function defaultScrubFs(): ConfigAuditScrubFs {
  return { promises: fs };
}

export async function detectConfigAuditScrubIssues(
  params: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    fs?: ConfigAuditScrubFs;
    doctorFixCommand?: string;
  } = {},
): Promise<ConfigAuditScrubIssue[]> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const auditPath = resolveConfigAuditLogPath(env, homedir);
  const preview = await scrubConfigAuditLog({
    fs: params.fs ?? defaultScrubFs(),
    env,
    homedir,
    dryRun: true,
  });
  if (preview.rewritten === 0) {
    return [];
  }
  return [
    {
      auditPath,
      scanned: preview.scanned,
      rewritten: preview.rewritten,
      skipped: preview.skipped,
      message: formatConfigAuditScrubMessage(preview.rewritten),
      fixHint: formatConfigAuditScrubFixHint(params.doctorFixCommand),
    },
  ];
}

export async function repairConfigAuditScrubIssues(
  params: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    fs?: ConfigAuditScrubFs;
    dryRun?: boolean;
  } = {},
): Promise<ConfigAuditScrubRepairResult> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const auditPath = resolveConfigAuditLogPath(env, homedir);
  const result = await scrubConfigAuditLog({
    fs: params.fs ?? defaultScrubFs(),
    env,
    homedir,
    dryRun: params.dryRun === true,
  });
  const changes =
    result.rewritten > 0
      ? [
          `${params.dryRun === true ? "Would scrub" : "Scrubbed"} ${formatEntryCount(
            result.rewritten,
          )} in ${auditPath}.`,
        ]
      : [];
  const warnings = result.aborted
    ? [
        "Config audit scrub was aborted because new entries were appended to config-audit.jsonl during the rewrite. No records were modified. Stop the gateway (or wait until it is idle) and rerun `openclaw doctor --fix`.",
      ]
    : [];
  return {
    auditPath,
    scanned: result.scanned,
    rewritten: result.rewritten,
    skipped: result.skipped,
    aborted: result.aborted,
    changes,
    warnings,
  };
}

export async function maybeScrubConfigAuditLog(params: {
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  doctorFixCommand?: string;
}): Promise<void> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;

  try {
    if (params.shouldRepair) {
      const result = await repairConfigAuditScrubIssues({ env, homedir });
      if (result.aborted) {
        note(
          result.warnings[0] ??
            "Config audit scrub was aborted because new entries were appended to config-audit.jsonl during the rewrite.",
          NOTE_TITLE,
        );
        return;
      }
      if (result.rewritten > 0) {
        note(
          `Scrubbed ${formatEntryCount(result.rewritten)} in config-audit.jsonl that still contained pre-redactor argv values. Rotate any credentials that may have been written to the log before the forward redactor shipped.`,
          NOTE_TITLE,
        );
      }
      return;
    }

    const [issue] = await detectConfigAuditScrubIssues({
      env,
      homedir,
      doctorFixCommand: params.doctorFixCommand,
    });
    if (issue) {
      note(`${issue.message} ${issue.fixHint}`, NOTE_TITLE);
    }
  } catch (err) {
    note(
      `Config audit scrub failed: ${err instanceof Error ? err.message : String(err)}`,
      NOTE_TITLE,
    );
  }
}
