import { clearActiveProgressLine } from "./terminal/progress-line.js";
// 导入清除活动进度线的函数
import { restoreTerminalState } from "./terminal/restore.js";
// 导入恢复终端状态的函数

// 定义运行时环境类型 - 包含日志、错误和退出函数
export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  // 日志输出函数
  error: (...args: unknown[]) => void;
  // 错误输出函数
  exit: (code: number) => void;
  // 进程退出函数
};

// 定义输出运行时环境类型 - 扩展 RuntimeEnv 并添加标准输出和 JSON 写入
export type OutputRuntimeEnv = RuntimeEnv & {
  writeStdout: (value: string) => void;
  // 标准输出写入函数
  writeJson: (value: unknown, space?: number) => void;
  // JSON 输出写入函数
};

// 判断是否应发出运行时日志
function shouldEmitRuntimeLog(env: NodeJS.ProcessEnv = process.env): boolean {
  // 如果不是 Vitest 测试环境，返回 true
  if (env.VITEST !== "true") {
    return true;
  }
  // 如果设置了 OPENCLAW_TEST_RUNTIME_LOG 环境变量，返回 true
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  // 检查 console.log 是否被模拟
  const maybeMockedLog = console.log as unknown as { mock?: unknown };
  return typeof maybeMockedLog.mock === "object";
}

// 判断是否应发出运行时标准输出
function shouldEmitRuntimeStdout(env: NodeJS.ProcessEnv = process.env): boolean {
  // 如果不是 Vitest 测试环境，返回 true
  if (env.VITEST !== "true") {
    return true;
  }
  // 如果设置了 OPENCLAW_TEST_RUNTIME_LOG 环境变量，返回 true
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  // 检查 process.stdout.write 是否被模拟
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: {
      mock?: unknown;
    };
  };
  return typeof stdout.write.mock === "object";
}

// 判断是否为管道关闭错误
function isPipeClosedError(err: unknown): boolean {
  // 提取错误码
  const code = (err as { code?: string })?.code;
  // 检查是否为 EPIPE 或 EIO 错误（管道关闭）
  return code === "EPIPE" || code === "EIO";
}

// 类型守卫函数：检查运行时是否有输出写入方法
function hasRuntimeOutputWriter(
  runtime: RuntimeEnv | OutputRuntimeEnv,
): runtime is OutputRuntimeEnv {
  // 如果 runtime 有 writeStdout 方法，则为 OutputRuntimeEnv
  return typeof (runtime as Partial<OutputRuntimeEnv>).writeStdout === "function";
}

// 写入标准输出的函数
function writeStdout(value: string): void {
  // 如果不应发出输出，直接返回
  if (!shouldEmitRuntimeStdout()) {
    return;
  }
  // 清除活动进度线
  clearActiveProgressLine();
  // 确保输出以换行符结尾
  const line = value.endsWith("\n") ? value : `${value}\n`;
  try {
    // 写入标准输出
    process.stdout.write(line);
  } catch (err) {
    // 如果是管道关闭错误，静默处理
    if (isPipeClosedError(err)) {
      return;
    }
    // 其他错误上抛
    throw err;
  }
}

// 创建运行时 IO 对象
function createRuntimeIo(): Pick<OutputRuntimeEnv, "log" | "error" | "writeStdout" | "writeJson"> {
  return {
    // 日志函数
    log: (...args: Parameters<typeof console.log>) => {
      // 如果不应发出日志，直接返回
      if (!shouldEmitRuntimeLog()) {
        return;
      }
      // 清除活动进度线
      clearActiveProgressLine();
      // 使用 console.log 输出
      console.log(...args);
    },
    // 错误函数
    error: (...args: Parameters<typeof console.error>) => {
      // 清除活动进度线
      clearActiveProgressLine();
      // 使用 console.error 输出
      console.error(...args);
    },
    // 标准输出写入函数
    writeStdout,
    // JSON 写入函数
    writeJson: (value: unknown, space = 2) => {
      // 将值序列化为带格式的 JSON 字符串并输出
      writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
  };
}

// 默认运行时环境对象
export const defaultRuntime: OutputRuntimeEnv = {
  // 展开运行时 IO 方法
  ...createRuntimeIo(),
  // 退出函数：恢复终端状态后退出进程
  exit: (code) => {
    restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
    process.exit(code);
    // 抛出错误以满足测试中的模拟需求（不可达代码）
    throw new Error("unreachable");
  },
};

// 创建不退出进程的运行时对象（用于测试）
export function createNonExitingRuntime(): OutputRuntimeEnv {
  return {
    // 展开运行时 IO 方法
    ...createRuntimeIo(),
    // 退出函数：抛出错误而不是退出进程
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}

// 向运行时写入 JSON 的函数
export function writeRuntimeJson(
  runtime: RuntimeEnv | OutputRuntimeEnv, // 运行时环境
  value: unknown, // 要写入的值
  space = 2, // JSON 格式化空格数
): void {
  // 如果运行时有输出写入方法，使用它
  if (hasRuntimeOutputWriter(runtime)) {
    runtime.writeJson(value, space);
    return;
  }
  // 否则使用 log 方法输出
  runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
}
