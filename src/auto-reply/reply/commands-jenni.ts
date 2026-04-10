import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { executeTrackedChatCommand } from "./bash-command.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

type JenniJobKey = "inspect" | "benchmark";

type JenniRequest =
  | { action: "help" }
  | { action: "invalid"; value: string }
  | {
      action: "run";
      job: JenniJobKey;
    };

const JENNI_JOB_SPECS: Record<JenniJobKey, { specPath: string; description: string }> = {
  inspect: {
    specPath: "app/jobs/host_inspection.yaml",
    description: "Run the Jenni Admin inspect job",
  },
  benchmark: {
    specPath: "app/jobs/benchmark_basic.yaml",
    description: "Run the Jenni Admin benchmark job",
  },
};

export function buildJenniUsageText() {
  return ["🧪 Usage:", "- /jenni inspect", "- /jenni benchmark"].join("\n");
}

export function buildJenniInvalidReply(value: string) {
  return [`⚠️ Unknown Jenni job: ${value}`, buildJenniUsageText()].join("\n");
}

export function parseJenniRequest(raw: string): JenniRequest | null {
  const trimmed = raw.trimStart();
  const match = trimmed.match(/^\/jenni(?:\s*:\s*|\s+|$)([\s\S]*)$/i);
  if (!match) {
    return null;
  }
  const rest = (match[1] ?? "").trim();
  if (!rest) {
    return { action: "help" };
  }
  const token = normalizeLowercaseStringOrEmpty(rest.split(/\s+/, 1)[0] ?? "");
  if (token === "help") {
    return { action: "help" };
  }
  if (token === "inspect" || token === "benchmark") {
    return { action: "run", job: token };
  }
  return { action: "invalid", value: token || rest };
}

function resolveJenniAdminDir() {
  const packageRoot =
    resolveOpenClawPackageRootSync({ cwd: process.cwd(), moduleUrl: import.meta.url }) ??
    process.cwd();
  return path.resolve(packageRoot, "..", "jenni-admin");
}

export function buildJenniExecCommand(job: JenniJobKey): string {
  const spec = JENNI_JOB_SPECS[job];
  return `.venv/bin/python3 -m app.bridge --spec ${spec.specPath}`;
}

export const handleJenniCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const request = parseJenniRequest(params.command.commandBodyNormalized);
  if (!request) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/jenni");
  if (unauthorized) {
    return unauthorized;
  }
  if (request.action === "help") {
    return {
      shouldContinue: false,
      reply: { text: buildJenniUsageText() },
    };
  }
  if (request.action === "invalid") {
    return {
      shouldContinue: false,
      reply: { text: buildJenniInvalidReply(request.value) },
    };
  }

  const spec = JENNI_JOB_SPECS[request.job];
  const commandText = buildJenniExecCommand(request.job);
  const workdir = resolveJenniAdminDir();
  const reply = await executeTrackedChatCommand({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    elevated: params.elevated,
    commandText,
    workdir,
    displayLabel: "jenni",
    busyText:
      "⚠️ A bash job is already running. Use !poll / !stop (or /bash poll / /bash stop) before starting another Jenni job.",
    runningText: (sessionId) =>
      `🧪 Jenni job started (${request.job}, session ${sessionId}). I’ll report the final bridge result when it finishes.`,
  });
  return {
    shouldContinue: false,
    reply: {
      text:
        normalizeOptionalString(reply.text) ?? `⚠️ Unable to start Jenni job: ${spec.description}.`,
    },
  };
};
