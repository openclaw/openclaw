import { spawnSubagentDirect } from "../../agents/subagent-spawn.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildSubagentTaskFromPath(params: {
  taskPath: string;
  dryRun: boolean;
  indexPath?: string;
}): string {
  const taskPathQuoted = shellSingleQuote(params.taskPath);
  const commandParts = [
    `node "skills/psd-automator/scripts/run-task.js"`,
    `--task ${taskPathQuoted}`,
  ];
  if (params.indexPath) {
    commandParts.push(`--index ${shellSingleQuote(params.indexPath)}`);
  }
  if (params.dryRun) {
    commandParts.push("--dry-run");
  }
  const command = commandParts.join(" ");
  return [
    "执行 PSD 自动化任务。",
    "在当前工作目录运行以下命令：",
    command,
    "请仅返回命令输出的关键信息（优先 JSON 结果和错误码）。",
  ].join("\n");
}

function buildSubagentTaskFromInline(params: {
  taskObject: Record<string, unknown>;
  dryRun: boolean;
  indexPath?: string;
}): string {
  const tmpPath = `/tmp/openclaw-psd-task-${Date.now()}.json`;
  const tmpPathQuoted = shellSingleQuote(tmpPath);
  const lines = [
    `cat > ${tmpPathQuoted} <<'EOF'`,
    JSON.stringify(params.taskObject, null, 2),
    "EOF",
  ];
  const runParts = [`node "skills/psd-automator/scripts/run-task.js" --task ${tmpPathQuoted}`];
  if (params.indexPath) {
    runParts.push(`--index ${shellSingleQuote(params.indexPath)}`);
  }
  if (params.dryRun) {
    runParts.push("--dry-run");
  }
  lines.push(runParts.join(" "));
  return [
    "执行 PSD 自动化任务。",
    "在当前工作目录按顺序执行以下命令：",
    lines.join("\n"),
    "请仅返回命令输出的关键信息（优先 JSON 结果和错误码）。",
  ].join("\n");
}

function parseAgentAndBody(raw: string): { agentId?: string; body: string } {
  const match = raw.trim().match(/^([^\s]+)\s*([\s\S]*)$/);
  if (!match) {
    return { body: "" };
  }
  return { agentId: match[1], body: (match[2] || "").trim() };
}

function parseFlags(text: string): { cleaned: string; dryRun: boolean; indexPath?: string } {
  const indexMatch = text.match(/--index\s+([^\s]+)/);
  const dryRun = /--dry-run\b/.test(text);
  const cleaned = text
    .replace(/--dry-run\b/g, "")
    .replace(/--index\s+[^\s]+/g, "")
    .trim();
  return { cleaned, dryRun, indexPath: indexMatch?.[1] };
}

function parseEditsFromChinese(text: string): Array<{ layerName: string; newText: string }> {
  const edits: Array<{ layerName: string; newText: string }> = [];
  const pattern =
    /(?:把)?([^，,。]+?)改成([\s\S]+?)(?=(?:，|,)?(?:把)?[^，,。]+?改成|(?:，|,)?(?:不要修改|并保存|并导出|保存成|保存到|放置在|然后|$))/g;
  for (const match of text.matchAll(pattern)) {
    const layerName = (match[1] || "").trim();
    const newText = (match[2] || "").trim().replace(/[，,。]\s*$/, "");
    if (layerName && newText) {
      edits.push({ layerName, newText });
    }
  }
  return edits;
}

function buildTaskFromNatural(
  text: string,
): { ok: true; task: Record<string, unknown> } | { ok: false; error: string } {
  const fileMatch = text.match(/(?:找到|找)\s*([^\s，。,]+\.psd)/i);
  const fileHint = fileMatch?.[1]?.trim();
  if (!fileHint) {
    return { ok: false, error: "未识别到 PSD 文件线索（如 xxx.psd）。" };
  }

  const edits = parseEditsFromChinese(text);
  if (edits.length === 0) {
    return { ok: false, error: "未识别到“把X改成Y”的修改项。" };
  }

  const copyThenEdit = /(拷贝|复制).*(桌面)/.test(text);
  const wantsPng = /png/i.test(text);
  const toDesktop = /(桌面)/.test(text);
  const exports: Array<Record<string, unknown>> = [];
  if (wantsPng) {
    exports.push({
      format: "png",
      dir: toDesktop ? "~/Desktop" : undefined,
    });
  }

  return {
    ok: true,
    task: {
      taskId: `task-nl-${Date.now()}`,
      input: {
        fileHint,
        edits,
      },
      workflow: {
        sourceMode: copyThenEdit ? "copy_then_edit" : "inplace",
        copyToDir: copyThenEdit ? "~/Desktop" : undefined,
      },
      output: {
        psd: { mode: "overwrite" },
        exports,
      },
      options: {
        styleLock: true,
        createBackup: true,
      },
    },
  };
}

export const handlePsdCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  const match = normalized.match(/^\/psd(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring /psd from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
  }

  const argsRaw = (match[1] || "").trim();
  const parsed = parseAgentAndBody(argsRaw);
  if (!parsed.agentId) {
    return stopWithText(
      "Usage: /psd <agentId> <taskJsonPath|中文需求> [--dry-run] [--index <indexPath>]\nExample: /psd design-mac-01 帮我找到a.psd，把姓名改成琳琳，并保存成png放置在桌面",
    );
  }
  const withFlags = parseFlags(parsed.body);
  const looksLikeTaskPath = /\.json$/i.test(withFlags.cleaned.split(/\s+/)[0] || "");
  const taskInstruction = looksLikeTaskPath
    ? buildSubagentTaskFromPath({
        taskPath: withFlags.cleaned.split(/\s+/)[0],
        dryRun: withFlags.dryRun,
        indexPath: withFlags.indexPath,
      })
    : (() => {
        const natural = buildTaskFromNatural(withFlags.cleaned);
        if (!natural.ok) {
          return `__PARSE_ERROR__${natural.error}`;
        }
        return buildSubagentTaskFromInline({
          taskObject: natural.task,
          dryRun: withFlags.dryRun,
          indexPath: withFlags.indexPath,
        });
      })();
  if (taskInstruction.startsWith("__PARSE_ERROR__")) {
    return stopWithText(
      `PSD 语义解析失败 (E_PARSE_FAILED): ${taskInstruction.replace("__PARSE_ERROR__", "")}`,
    );
  }

  const commandTo = typeof params.command.to === "string" ? params.command.to.trim() : "";
  const originatingTo =
    typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo.trim() : "";
  const fallbackTo = typeof params.ctx.To === "string" ? params.ctx.To.trim() : "";
  const normalizedTo = originatingTo || commandTo || fallbackTo || undefined;
  const requesterKey = params.sessionKey;
  const task = taskInstruction;

  const result = await spawnSubagentDirect(
    {
      task,
      agentId: parsed.agentId,
      mode: "run",
      cleanup: "keep",
      expectsCompletionMessage: true,
      label: "psd-automator",
    },
    {
      agentSessionKey: requesterKey,
      agentChannel: params.ctx.OriginatingChannel ?? params.command.channel,
      agentAccountId: params.ctx.AccountId,
      agentTo: normalizedTo,
      agentThreadId: params.ctx.MessageThreadId,
      agentGroupId: params.sessionEntry?.groupId ?? null,
      agentGroupChannel: params.sessionEntry?.groupChannel ?? null,
      agentGroupSpace: params.sessionEntry?.space ?? null,
    },
  );

  if (result.status === "accepted") {
    return stopWithText(
      `已派发 PSD 任务到 ${parsed.agentId}（run ${result.runId?.slice(0, 8) ?? "unknown"}）。`,
    );
  }
  return stopWithText(`PSD 派发失败: ${result.error ?? result.status}`);
};
