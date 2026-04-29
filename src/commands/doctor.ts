import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";
/**
 * doctor.ts
 *
 * OpenClaw 医生命令入口模块
 *
 * 本模块是 `openclaw doctor` 命令的主入口点。
 * doctor 命令用于诊断 OpenClaw 运行环境的健康状态，
 * 检查配置、依赖、服务状态等关键组件。
 *
 * 主要功能：
 * - 提供健康检查命令的统一入口
 * - 导入并执行健康检查流程
 * - 支持自定义运行时环境和选项
 *
 * 使用方式：
 * ```typescript
 * await doctorCommand(runtime, options);
 * ```
 */

/**
 * 执行医命断命令的主函数
 * @param runtime - 运行时环境配置
 * @param options - 医生命令的可选配置参数
 */
export async function doctorCommand(runtime?: RuntimeEnv, options?: DoctorOptions): Promise<void> {
  const doctorHealth = await import("../flows/doctor-health.js");
  await doctorHealth.doctorCommand(runtime, options);
}
