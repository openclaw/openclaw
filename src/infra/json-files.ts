/**
 * 从错误对象中提取错误码
 * @param err - 任意错误对象
 * @returns 错误码字符串或undefined
 */
function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * JSON文件读取错误类型
 * filePath: 出错的文件路径
 * reason: 错误原因，'read'表示读取失败，'parse'表示解析失败
 */
export class JsonFileReadError extends Error {
  readonly filePath: string;
  readonly reason: "read" | "parse";

  constructor(filePath: string, reason: "read" | "parse", cause: unknown) {
    super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
    this.name = "JsonFileReadError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

/**
 * Windows平台上的原子文件替换操作
 * 处理Windows上文件替换可能遇到的权限问题和符号链接情况
 * @param tempPath - 临时文件路径
 * @param filePath - 目标文件路径
 * @param mode - 文件权限模式
 */
async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  const existing = await fs.lstat(filePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
    return;
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
  }
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

/**
 * 异步读取JSON文件
 * @param filePath - 文件路径
 * @returns 解析后的JSON对象，读取或解析失败时返回null
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 异步读取JSON文件，失败时抛出详细错误
 * @param filePath - 文件路径
 * @returns 解析后的JSON对象
 * @throws JsonFileReadError 当文件不存在或JSON解析失败时
 */
export async function readDurableJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") {
      return null;
    }
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

/**
 * 同步读取JSON文件
 * @param filePath - 文件路径
 * @returns 解析后的JSON对象或null
 */
export function readJsonFileSync(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * 原子写入JSON文件
 * 使用临时文件和原子重命名确保文件完整性
 * @param filePath - 目标文件路径
 * @param value - 要写入的JSON值
 * @param options - 可选配置：文件权限、尾部换行、目录权限
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    ensureDirMode: options?.ensureDirMode,
    appendTrailingNewline: options?.trailingNewline,
  });
}

/**
 * 原子写入文本文件
 * 创建临时文件写入后原子重命名，支持Windows兼容性和目录同步
 * @param filePath - 目标文件路径
 * @param content - 要写入的文本内容
 * @param options - 可选配置
 */
export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload =
    options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {
    }
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * 创建异步锁函数
 * 确保同一时间只有一个异步操作在执行
 * @returns 一个包装函数，接受异步操作并确保串行执行
 */
export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
