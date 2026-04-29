import { formatCliCommand } from "../cli/command-format.js";
/**
 * onboard.ts
 *
 * OpenClaw 入门向导命令模块
 *
 * 本模块实现 `openclaw onboard` 或 `openclaw setup` 命令。
 * 该命令引导用户完成 OpenClaw 的初始配置和设置过程。
 *
 * 主要功能：
 * - 提供交互式设置向导（默认模式）
 * - 提供非交互式无人值守安装（适合自动化部署）
 * - 处理遗留认证选项的迁移
 * - 支持重置操作（config/credentials/sessions）
 * - 验证平台兼容性和运行时环境
 *
 * 使用方式：
 * ```bash
 * openclaw onboard                    # 交互式向导
 * openclaw onboard --non-interactive  # 非交互式安装
 * openclaw onboard --reset            # 重置配置
 * ```
 *
 * 重置范围选项：
 * - config: 仅重置配置
 * - config+creds+sessions: 重置配置、凭证和会话
 * - full: 完全重置
 */

import { readConfigFileSnapshot } from "../config/config.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import {
  formatDeprecatedNonInteractiveAuthChoiceError,
  isDeprecatedAuthChoice,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";
import { DEFAULT_WORKSPACE, handleReset } from "./onboard-helpers.js";
import { runInteractiveSetup } from "./onboard-interactive.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";
import type { OnboardOptions, ResetScope } from "./onboard-types.js";

const VALID_RESET_SCOPES = new Set<ResetScope>(["config", "config+creds+sessions", "full"]);

export async function setupWizardCommand(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  assertSupportedRuntime(runtime);
  const originalAuthChoice = opts.authChoice;
  const normalizedAuthChoice = normalizeLegacyOnboardAuthChoice(originalAuthChoice, {
    env: process.env,
  });
  if (opts.nonInteractive && isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
    runtime.error(
      formatDeprecatedNonInteractiveAuthChoiceError(originalAuthChoice, {
        env: process.env,
      })!,
    );
    runtime.exit(1);
    return;
  }
  if (isDeprecatedAuthChoice(originalAuthChoice, { env: process.env })) {
    runtime.log(
      resolveDeprecatedAuthChoiceReplacement(originalAuthChoice, { env: process.env })!.message,
    );
  }
  const flow = opts.flow === "manual" ? ("advanced" as const) : opts.flow;
  const normalizedOpts =
    normalizedAuthChoice === opts.authChoice && flow === opts.flow
      ? opts
      : { ...opts, authChoice: normalizedAuthChoice, flow };
  if (
    normalizedOpts.secretInputMode &&
    normalizedOpts.secretInputMode !== "plaintext" && // pragma: allowlist secret
    normalizedOpts.secretInputMode !== "ref" // pragma: allowlist secret
  ) {
    runtime.error('Invalid --secret-input-mode. Use "plaintext" or "ref".');
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.resetScope && !VALID_RESET_SCOPES.has(normalizedOpts.resetScope)) {
    runtime.error('Invalid --reset-scope. Use "config", "config+creds+sessions", or "full".');
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.nonInteractive && normalizedOpts.acceptRisk !== true) {
    runtime.error(
      [
        "Non-interactive setup requires explicit risk acknowledgement.",
        "Read: https://docs.openclaw.ai/security",
        `Re-run with: ${formatCliCommand("openclaw onboard --non-interactive --accept-risk ...")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }

  if (normalizedOpts.reset) {
    const snapshot = await readConfigFileSnapshot();
    const baseConfig = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
    const workspaceDefault =
      normalizedOpts.workspace ?? baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;
    const resetScope: ResetScope = normalizedOpts.resetScope ?? "config+creds+sessions";
    await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
  }

  if (process.platform === "win32") {
    runtime.log(
      [
        "Windows detected - OpenClaw runs great on WSL2!",
        "Native Windows might be trickier.",
        "Quick setup: wsl --install (one command, one reboot)",
        "Guide: https://docs.openclaw.ai/windows",
      ].join("\n"),
    );
  }

  if (normalizedOpts.nonInteractive) {
    await runNonInteractiveSetup(normalizedOpts, runtime);
    return;
  }

  await runInteractiveSetup(normalizedOpts, runtime);
}

export const onboardCommand = setupWizardCommand;

export type { OnboardOptions } from "./onboard-types.js";
export type { OnboardOptions as SetupWizardOptions } from "./onboard-types.js";
