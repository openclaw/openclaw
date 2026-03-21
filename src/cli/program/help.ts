import type { Command } from "commander";
import { resolveCommitHash } from "../../infra/git-commit.js";
import { formatDocsLink } from "../../terminal/links.js";
import { isRich, theme } from "../../terminal/theme.js";
import { escapeRegExp } from "../../utils.js";
import { hasFlag, hasRootVersionAlias } from "../argv.js";
import { formatCliBannerLine, hasEmittedCliBanner } from "../banner.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { CLI_LOG_LEVEL_VALUES, parseCliLogLevelOption } from "../log-level-option.js";
import type { ProgramContext } from "./context.js";
import { getCoreCliCommandsWithSubcommands } from "./core-command-descriptors.js";
import { getSubCliCommandsWithSubcommands } from "./subcli-descriptors.js";

const CLI_NAME = resolveCliName();
const CLI_NAME_PATTERN = escapeRegExp(CLI_NAME);
const ROOT_COMMANDS_WITH_SUBCOMMANDS = new Set([
  ...getCoreCliCommandsWithSubcommands(),
  ...getSubCliCommandsWithSubcommands(),
]);
const ROOT_COMMANDS_HINT =
  "带 * 的命令有子命令，运行 <command> --help 查看详情 / Commands with * have subcommands. Run <command> --help for details.";

const EXAMPLES = [
  ["openclaw models --help", "显示 models 命令详细帮助 / Show detailed help for models command."],
  [
    "openclaw channels login --verbose",
    "链接个人 WhatsApp 并显示 QR 码 / Link personal WhatsApp and show QR + logs.",
  ],
  [
    'openclaw message send --target +15555550123 --message "Hi" --json',
    "发送消息并打印 JSON 结果 / Send message and print JSON result.",
  ],
  ["openclaw gateway --port 18789", "本地运行 WebSocket 网关 / Run WebSocket Gateway locally."],
  ["openclaw --dev gateway", "开发模式网关（隔离状态） / Dev Gateway (isolated state/config)."],
  ["openclaw gateway --force", "强制启动网关（杀死占用端口的进程）/ Force start gateway."],
  ["openclaw gateway ...", "通过 WebSocket 控制网关 / Gateway control via WebSocket."],
  [
    'openclaw agent --to +15555550123 --message "Run summary" --deliver',
    "直接与代理对话并可选发送回复 / Talk to agent, optionally send reply.",
  ],
  [
    'openclaw message send --channel telegram --target @mychat --message "Hi"',
    "通过 Telegram 机器人发送 / Send via Telegram bot.",
  ],
] as const;

export function configureProgramHelp(program: Command, ctx: ProgramContext) {
  program
    .name(CLI_NAME)
    .description("")
    .version(ctx.programVersion)
    .option(
      "--dev",
      "开发模式：独立状态存储于 ~/.openclaw-dev，默认网关端口 19001 / Dev profile: isolate state under ~/.openclaw-dev, default gateway port 19001",
    )
    .option(
      "--profile <name>",
      "使用命名配置（隔离状态和配置） / Use a named profile (isolates state/config under ~/.openclaw-<name>)",
    )
    .option(
      "--log-level <level>",
      `日志级别 (${CLI_LOG_LEVEL_VALUES}) / Log level override`,
      parseCliLogLevelOption,
    );

  program.option("--no-color", "禁用彩色输出 / Disable ANSI colors", false);
  program.helpOption("-h, --help", "显示帮助 / Display help for command");
  program.helpCommand("help [command]", "显示命令帮助 / Display help for command");

  program.configureHelp({
    // sort options and subcommands alphabetically
    sortSubcommands: true,
    sortOptions: true,
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => {
      const isRootCommand = cmd.parent === program;
      const hasSubcommands = isRootCommand && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(cmd.name());
      return theme.command(hasSubcommands ? `${cmd.name()} *` : cmd.name());
    },
  });

  const formatHelpOutput = (str: string) => {
    let output = str;
    const isRootHelp = new RegExp(
      `^Usage:\\s+${CLI_NAME_PATTERN}\\s+\\[options\\]\\s+\\[command\\]\\s*$`,
      "m",
    ).test(output);
    if (isRootHelp && /^Commands:/m.test(output)) {
      output = output.replace(/^Commands:/m, `Commands:\n  ${theme.muted(ROOT_COMMANDS_HINT)}`);
    }

    return output
      .replace(/^Usage:/gm, theme.heading("Usage:"))
      .replace(/^Options:/gm, theme.heading("Options:"))
      .replace(/^Commands:/gm, theme.heading("Commands:"));
  };

  program.configureOutput({
    writeOut: (str) => {
      process.stdout.write(formatHelpOutput(str));
    },
    writeErr: (str) => {
      process.stderr.write(formatHelpOutput(str));
    },
    outputError: (str, write) => write(theme.error(str)),
  });

  if (
    hasFlag(process.argv, "-V") ||
    hasFlag(process.argv, "--version") ||
    hasRootVersionAlias(process.argv)
  ) {
    const commit = resolveCommitHash({ moduleUrl: import.meta.url });
    console.log(
      commit ? `OpenClaw ${ctx.programVersion} (${commit})` : `OpenClaw ${ctx.programVersion}`,
    );
    process.exit(0);
  }

  program.addHelpText("beforeAll", () => {
    if (hasEmittedCliBanner()) {
      return "";
    }
    const rich = isRich();
    const line = formatCliBannerLine(ctx.programVersion, { richTty: rich });
    return `\n${line}\n`;
  });

  const fmtExamples = EXAMPLES.map(
    ([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`,
  ).join("\n");

  program.addHelpText("afterAll", ({ command }) => {
    if (command !== program) {
      return "";
    }
    const docs = formatDocsLink("/cli", "docs.openclaw.ai/cli");
    return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
  });
}
