// Node.js 文件系统模块
import fs from "node:fs";
// Node.js 路径模块
import path from "node:path";

// 检查候选路径是否在基础路径内部
// 使用相对路径计算来判断，不能以 ".." 开头且不是绝对路径
export function isPathInside(basePath: string, candidatePath: string): boolean {
  // 解析为绝对路径
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  // 计算相对路径
  const rel = path.relative(base, candidate);
  // 如果相对路径为空（相同路径）或不是以 ../ 开头且不是 .. 且不是绝对路径
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

// 安全的 realpathSync 包装器
// 返回解析后的路径，失败时返回 null
function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

// 使用 realpath 检查路径是否在基础路径内部
// opts.requireRealpath: 是否要求 realpath 成功，默认为 true
export function isPathInsideWithRealpath(
  basePath: string,
  candidatePath: string,
  opts?: { requireRealpath?: boolean },
): boolean {
  // 首先检查基本路径关系
  if (!isPathInside(basePath, candidatePath)) {
    return false;
  }
  // 对基础路径和候选路径进行 realpath 解析
  const baseReal = safeRealpathSync(basePath);
  const candidateReal = safeRealpathSync(candidatePath);
  if (!baseReal || !candidateReal) {
    // 默认返回 false（安全）：只有调用者明确选择 requireRealpath: false 时才绕过 realpath 检查
    // 所有生产调用者已经传递 requireRealpath: true
    return opts?.requireRealpath === false;
  }
  return isPathInside(baseReal, candidateReal);
}

// 检查扫描路径是否应跳过
// 跳过包含 node_modules 或以点开头的目录（除了 . 和 ..）
export function extensionUsesSkippedScannerPath(entry: string): boolean {
  const segments = entry.split(/[\\/]+/).filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      (segment.startsWith(".") && segment !== "." && segment !== ".."),
  );
}
