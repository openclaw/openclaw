import type { Command } from "commander";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { theme } from "../../terminal/theme.js";

/**
 * Built-in memory extraction prompts for the three-layer system
 */
export const MEMORY_PROMPTS = {
  hourly: `你是记忆微同步 agent。检查最近是否有新的有价值内容。

规则：
1. 先用 sessions_list 查看当前活跃 session
2. 再用 memory_search 搜索最近的对话内容（搜"今天"、最近话题关键词等），这能覆盖已被 /new 关闭的历史 session
3. 没有新的有意义内容（<2条用户消息）直接回复 NO_REPLY
4. 有新内容则提取关键信息 append 到 memory/YYYY-MM-DD.md（今天日期），格式：## HH:MM 简短标题 换行 - 要点
5. 不要重复已记录的内容（先读 memory/YYYY-MM-DD.md 检查）
6. 完成后回复 NO_REPLY`,

  daily: `你是每日记忆蒸馏 agent。将今天所有对话蒸馏为结构化日志。

步骤：
1. 用 sessions_list(activeMinutes=1440) 获取今天活跃的 session
2. 对每个有意义的 session（>=2条用户消息），用 sessions_history 获取内容
3. 额外步骤：用 memory_search 搜索今天的关键词（如日期、项目名等），捕获已被 /new 关闭的历史 session 中的内容
4. 幂等性：检查 memory/YYYY-MM-DD.md 已有内容，跳过已处理的 session
5. 蒸馏为结构化格式写入 memory/YYYY-MM-DD.md（## 主题标题 换行 - 关键决策/结论 - 重要信息/偏好 - 待办/后续行动）
6. 将超过 7 天的 daily log 移动到 memory/archive/YYYY/ 目录
7. 完成后回复 NO_REPLY`,

  weekly: `你是每周记忆巩固 agent。聚合本周记忆，精简 MEMORY.md。

步骤：
1. 读取本周所有 memory/YYYY-MM-DD.md 日志
2. 读取当前 MEMORY.md
3. 提取本周新的偏好、决策、项目状态、技术配置、人物关系、重要教训
4. 更新 MEMORY.md：合并新信息到对应分类，剪枝过时/已失效信息，保持精简（软上限约200行），更新底部最后更新时间戳
5. 将本周日志压缩摘要写入 memory/weekly/YYYY-WXX.md（XX=周数）
6. 完成后回复 NO_REPLY`,
};

function createGatewayOpts() {
  const opts = {};
  addGatewayClientOptions(opts as any);
  return opts;
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Manage automatic memory extraction (three-layer cron system)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} See https://github.com/dztabel-happy/openclaw-memory-fusion for full documentation\n`,
    );

  // Memory setup command
  memory
    .command("setup")
    .description("Initialize and enable the three-layer memory system")
    .option("--tz <timezone>", "Timezone for cron jobs", "Asia/Shanghai")
    .option(
      "--hourly-model <model>",
      "Model for hourly sync",
      "google/gemini-3-flash-preview",
    )
    .option(
      "--daily-model <model>",
      "Model for daily sync",
      "openrouter/minimax/minimax-m2.5",
    )
    .option(
      "--weekly-model <model>",
      "Model for weekly tidy",
      "anyrouter/claude-opus-4-6",
    )
    .action(async (opts) => {
      console.log(theme.accent("🧠 Setting up Three-Layer Memory System...\n"));

      const gatewayOpts = createGatewayOpts();

      // Step 1: Initialize QMD collection
      console.log(theme.info("Step 1: Checking QMD..."));
      try {
        const { spawn } = await import("node:child_process");
        const qmdCheck = spawn("qmd", ["status"], {
          stdio: "pipe",
          shell: true,
        });

        let qmdStatus = "";
        qmdCheck.stdout.on("data", (data) => {
          qmdStatus += data.toString();
        });

        await new Promise((resolve) => qmdCheck.on("close", resolve));

        if (qmdStatus.includes("0 files indexed")) {
          console.log(theme.info("  Creating QMD collection..."));
          const qmdAdd = spawn("qmd", ["collection", "add", "."], {
            cwd: process.env.OPENCLAW_WORKSPACE || process.env.HOME + "/.openclaw/workspace",
            stdio: "pipe",
            shell: true,
          });
          await new Promise((resolve) => qmdAdd.on("close", resolve));
          console.log(theme.success("  ✅ QMD collection created"));
        } else {
          console.log(theme.success("  ✅ QMD already initialized"));
        }
      } catch (err) {
        console.log(
          theme.warn(
            "  ⚠️  QMD not found. Please install: npm install -g @tobilu/qmd",
          ),
        );
      }

      // Step 2: Add cron jobs
      console.log(theme.info("\nStep 2: Creating cron jobs..."));

      // Add hourly cron job
      const hourlyResult = await callGatewayFromCli(
        "cron.add",
        gatewayOpts,
        {
          name: "memory-hourly",
          schedule: { kind: "cron", expression: "0 10,13,16,19,22 * * *" },
          timezone: opts.tz,
          session: { kind: "isolated" },
          agent: "main",
          model: opts.hourlyModel,
          timeoutSeconds: 120,
          delivery: { mode: "none" },
          message: MEMORY_PROMPTS.hourly,
        },
      );

      if (hourlyResult.ok) {
        console.log(theme.success("  ✅ memory-hourly (L1: every 3h during daytime)"));
      } else {
        console.log(
          theme.warn("  ⚠️  memory-hourly may already exist"),
        );
      }

      // Add daily cron job
      const dailyResult = await callGatewayFromCli(
        "cron.add",
        gatewayOpts,
        {
          name: "memory-daily",
          schedule: { kind: "cron", expression: "0 23 * * *" },
          timezone: opts.tz,
          session: { kind: "isolated" },
          agent: "main",
          model: opts.dailyModel,
          timeoutSeconds: 300,
          delivery: { mode: "none" },
          message: MEMORY_PROMPTS.daily,
        },
      );

      if (dailyResult.ok) {
        console.log(theme.success("  ✅ memory-daily (L2: every night at 23:00)"));
      } else {
        console.log(
          theme.warn("  ⚠️  memory-daily may already exist"),
        );
      }

      // Add weekly cron job
      const weeklyResult = await callGatewayFromCli(
        "cron.add",
        gatewayOpts,
        {
          name: "memory-weekly",
          schedule: { kind: "cron", expression: "0 22 * * 0" },
          timezone: opts.tz,
          session: { kind: "isolated" },
          agent: "main",
          model: opts.weeklyModel,
          timeoutSeconds: 600,
          delivery: { mode: "none" },
          message: MEMORY_PROMPTS.weekly,
        },
      );

      if (weeklyResult.ok) {
        console.log(theme.success("  ✅ memory-weekly (L3: every Sunday at 22:00)"));
      } else {
        console.log(
          theme.warn("  ⚠️  memory-weekly may already exist"),
        );
      }

      // Step 3: Verify configuration
      console.log(theme.info("\nStep 3: Verifying configuration..."));
      const configResult: any = await callGatewayFromCli(
        "memory.getConfig",
        gatewayOpts,
        {},
      );

      if (configResult.ok && configResult.config) {
        const sessions = configResult.config.qmd?.sessions;
        if (sessions?.enabled && (sessions.retentionDays ?? 0) > 0) {
          console.log(
            theme.success(
              `  ✅ Session indexing enabled (retention: ${sessions.retentionDays} days)`,
            ),
          );
        } else {
          console.log(
            theme.warn(
              "  ⚠️  Session indexing may not be enabled. Check openclaw.json:",
            ),
          );
          console.log(
            theme.muted(
              `    memory.qmd.sessions.enabled = true\n    memory.qmd.sessions.retentionDays = 30`,
            ),
          );
        }
      }

      console.log(theme.success("\n🎉 Memory system setup complete!"));
      console.log(theme.muted("\nThe three-layer memory system is now active:"));
      console.log(theme.muted("  - L1: Hourly micro-sync (lightweight check)"));
      console.log(theme.muted("  - L2: Daily sync (structured logging)"));
      console.log(theme.muted("  - L3: Weekly tidy (memory consolidation)"));
      console.log(
        theme.muted(
          "\nDocs: https://github.com/dztabel-happy/openclaw-memory-fusion",
        ),
      );
    });

  // Memory status command
  memory
    .command("status")
    .description("Show memory system status and statistics")
    .action(async () => {
      const gatewayOpts = createGatewayOpts();

      // Get cron jobs
      const cronResult: any = await callGatewayFromCli("cron.list", gatewayOpts, {});
      const memoryJobs =
        cronResult.jobs?.filter((j: any) =>
          j.name.startsWith("memory-"),
        ) ?? [];

      console.log(theme.accent("🧠 Memory System Status\n"));

      if (memoryJobs.length === 0) {
        console.log(
          theme.warn("  No memory cron jobs found. Run 'openclaw memory setup' first."),
        );
        return;
      }

      console.log(theme.info("Cron Jobs:"));
      for (const job of memoryJobs) {
        const status = job.enabled
          ? theme.success("enabled")
          : theme.muted("disabled");
        console.log(
          `  ${theme.command(job.name)}: ${status} (next: ${job.nextRunAtMs ? new Date(job.nextRunAtMs).toLocaleString() : "N/A"})`,
        );
      }

      // Get QMD stats
      console.log(theme.info("\nQMD Index:"));
      try {
        const { spawn } = await import("node:child_process");
        const qmdStatus = spawn("qmd", ["status"], {
          stdio: "pipe",
          shell: true,
        });

        let output = "";
        qmdStatus.stdout.on("data", (data) => {
          output += data.toString();
        });

        await new Promise((resolve) => qmdStatus.on("close", resolve));

        const filesMatch = output.match(/Total:\s+(\d+)/);
        const vectorsMatch = output.match(/Vectors:\s+(\d+)/);

        if (filesMatch) {
          console.log(theme.success(`  Files indexed: ${filesMatch[1]}`));
        }
        if (vectorsMatch) {
          console.log(theme.success(`  Vectors embedded: ${vectorsMatch[1]}`));
        }
      } catch {
        console.log(theme.warn("  QMD not available"));
      }
    });

  // Memory disable command
  memory
    .command("disable")
    .description("Disable all memory cron jobs")
    .action(async () => {
      const gatewayOpts = createGatewayOpts();
      const cronResult: any = await callGatewayFromCli("cron.list", gatewayOpts, {});
      const memoryJobs =
        cronResult.jobs?.filter((j: any) =>
          j.name.startsWith("memory-"),
        ) ?? [];

      console.log(theme.accent("🧠 Disabling Memory System...\n"));

      for (const job of memoryJobs) {
        await callGatewayFromCli(
          "cron.update",
          gatewayOpts,
          { jobId: job.id, enabled: false },
        );
        console.log(theme.success(`  ✅ Disabled ${job.name}`));
      }

      console.log(theme.success("\n🎉 Memory system disabled"));
    });
}