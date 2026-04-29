// 导入 clack 的 intro 和 outro 函数用于提示样式
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
// 医生选项类型
import type { DoctorOptions } from "../commands/doctor-prompter.js";
// 运行时环境类型
import type { RuntimeEnv } from "../runtime.js";
// 提示样式函数
import { stylePromptTitle } from "../terminal/prompt-style.js";

// 内部样式化 intro 函数
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
// 内部样式化 outro 函数
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

// 医生命令主函数
export async function doctorCommand(runtime?: RuntimeEnv, options: DoctorOptions = {}) {
  // 获取有效运行时（如果没有提供则导入默认运行时）
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  // 创建医生提示器
  const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
  // 导入打印向导头部函数
  const { printWizardHeader } = await import("../commands/onboard-helpers.js");
  // 创建提示器
  const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });
  // 打印向导头部
  printWizardHeader(effectiveRuntime);
  // 显示 intro
  intro("OpenClaw doctor");

  // 解析 OpenClaw 包根目录
  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  // 导入可能提供的更新前检查函数
  const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
  // 执行更新前检查
  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime: effectiveRuntime,
    options,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  // 如果已处理，直接返回
  if (updateResult.handled) {
    return;
  }

  // 导入各种医生检查函数
  const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
  const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
  const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
  // 执行 UI 协议修复检查
  await maybeRepairUiProtocolFreshness(effectiveRuntime, prompter);
  // 记录源安装问题
  noteSourceInstallIssues(root);
  // 记录启动优化提示
  noteStartupOptimizationHints();

  // 导入配置加载和迁移函数
  const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (p) => prompter.confirm(p),
    runtime: effectiveRuntime,
    prompter,
  });
  // 获取配置路径常量
  const { CONFIG_PATH } = await import("../config/config.js");
  // 创建医生上下文
  const ctx = {
    runtime: effectiveRuntime,
    options,
    prompter,
    configResult,
    cfg: configResult.cfg,  // 配置对象
    cfgForPersistence: structuredClone(configResult.cfg),  // 用于持久化的配置克隆
    sourceConfigValid: configResult.sourceConfigValid ?? true,  // 源配置是否有效
    configPath: configResult.path ?? CONFIG_PATH,  // 配置路径
  };
  // 导入并运行医生健康贡献检查
  const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
  await runDoctorHealthContributions(ctx);

  // 显示完成消息
  outro("Doctor complete.");
}
