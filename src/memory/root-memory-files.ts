import fs from "node:fs/promises";
import path from "node:path";

/**
 * 规范的根内存文件名
 */
export const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";

/**
 * 遗留的根内存文件名（小写版本）
 */
export const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";

/**
 * 根内存修复目录的相对路径
 */
export const ROOT_MEMORY_REPAIR_RELATIVE_DIR = ".openclaw-repair/root-memory";

/**
 * 解析规范化的根内存文件路径
 * @param workspaceDir - 工作区目录
 * @returns 完整的文件路径
 */
export function resolveCanonicalRootMemoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, CANONICAL_ROOT_MEMORY_FILENAME);
}

/**
 * 解析遗留的根内存文件路径
 * @param workspaceDir - 工作区目录
 * @returns 完整的文件路径
 */
export function resolveLegacyRootMemoryPath(workspaceDir: string): string {
  return path.join(workspaceDir, LEGACY_ROOT_MEMORY_FILENAME);
}

/**
 * 解析根内存修复目录路径
 * @param workspaceDir - 工作区目录
 * @returns 完整的目录路径
 */
export function resolveRootMemoryRepairDir(workspaceDir: string): string {
  return path.join(workspaceDir, ".openclaw-repair", "root-memory");
}

/**
 * 规范化工作区相对路径
 * @param value - 原始路径值
 * @returns 规范化后的相对路径
 */
export function normalizeWorkspaceRelativePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 检查工作区中是否存在指定条目
 * @param dir - 目录路径
 * @param name - 条目名称
 * @returns 是否存在
 */
export async function exactWorkspaceEntryExists(dir: string, name: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.includes(name);
  } catch {
    return false;
  }
}

/**
 * 解析规范化的根内存文件
 * 查找规范文件（MEMORY.md），忽略符号链接
 * @param workspaceDir - 工作区目录
 * @returns 文件路径或null（如果不存在）
 */
export async function resolveCanonicalRootMemoryFile(workspaceDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === CANONICAL_ROOT_MEMORY_FILENAME &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      ) {
        return path.join(workspaceDir, entry.name);
      }
    }
  } catch {}
  return null;
}

/**
 * 检查是否应跳过根内存辅助路径
 * @param params - 工作区目录和绝对路径
 * @returns 是否应跳过
 */
export function shouldSkipRootMemoryAuxiliaryPath(params: {
  workspaceDir: string;
  absPath: string;
}): boolean {
  const relative = path.relative(params.workspaceDir, params.absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const normalized = normalizeWorkspaceRelativePath(relative);
  return (
    normalized === LEGACY_ROOT_MEMORY_FILENAME ||
    normalized === ROOT_MEMORY_REPAIR_RELATIVE_DIR ||
    normalized.startsWith(`${ROOT_MEMORY_REPAIR_RELATIVE_DIR}/`)
  );
}
