// 引入 Node.js 原生模块，用于加密、文件系统操作、HTTP/HTTPS 请求和网络路径处理
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
// 引入跨域重定向时保留安全头部的工具函数
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
// 引入 SSRF 防护的 hostname 解析工具
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir } from "../utils.js";
import { detectMime, extensionForMime } from "./mime.js";
import { isSafeOpenError, readLocalFileSafely, type SafeOpenLikeError } from "./store.runtime.js";

// 获取媒体存储目录路径，默认为配置目录下的 media 子目录
const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
// 媒体文件默认最大字节数：5MB
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB default
// 本地变量，存储最大字节数配置
const MAX_BYTES = MEDIA_MAX_BYTES;
// 媒体文件默认 TTL（生存时间）：2分钟，用于清理过期文件
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
// 文件权限设置为 0o644，允许其他 UID 读取（以便 Docker 沙箱容器访问）
// 但包含 state/media 的目录保持 0o700，这是信任边界
const MEDIA_FILE_MODE = 0o644;
// 清理旧媒体文件的选项类型
type CleanOldMediaOptions = {
  recursive?: boolean;      // 是否递归清理子目录
  pruneEmptyDirs?: boolean; // 是否删除空目录
};
// HTTP 请求实现的类型别名
type RequestImpl = typeof httpRequest;
// SSRF 防护 hostname 解析实现的类型别名
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;

// 使用 Node.js 原生的 HTTP/HTTPS 请求实现作为默认值
const defaultHttpRequestImpl: RequestImpl = httpRequest;
const defaultHttpsRequestImpl: RequestImpl = httpsRequest;
// 使用内置的 SSRF 防护 hostname 解析作为默认值
const defaultResolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = resolvePinnedHostname;

// 可注入的依赖实现（用于测试）
let httpRequestImpl: RequestImpl = defaultHttpRequestImpl;
let httpsRequestImpl: RequestImpl = defaultHttpsRequestImpl;
let resolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = defaultResolvePinnedHostnameImpl;

/**
 * 设置媒体存储的网络依赖项（仅用于测试）
 * @param deps - 可选的网络依赖项，包括 HTTP 请求和 SSRF 防护实现
 */
export function setMediaStoreNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void {
  // 使用提供的实现或回退到默认值
  httpRequestImpl = deps?.httpRequest ?? defaultHttpRequestImpl;
  httpsRequestImpl = deps?.httpsRequest ?? defaultHttpsRequestImpl;
  resolvePinnedHostnameImpl = deps?.resolvePinnedHostname ?? defaultResolvePinnedHostnameImpl;
}

/**
 * 对文件名进行跨平台安全清理
 * 移除 Windows/SharePoint/所有平台上的不安全字符
 * 保留：字母数字、点、连字符、下划线、Unicode 字母/数字
 * @param name - 原始文件名
 * @returns 清理后的安全文件名
 */
function sanitizeFilename(name: string): string {
  const trimmed = name.trim(); // 去除首尾空白
  if (!trimmed) {
    return ""; // 空输入返回空字符串
  }
  // 替换所有非安全字符为下划线，支持 Unicode 字符
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  // 压缩多个下划线为单个，去除首尾下划线，限制长度不超过 60 字符
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/**
 * 从媒体文件路径中提取原始文件名
 * 格式：{original}---{uuid}.{ext} → 返回 "{original}.{ext}"
 * 如果格式不匹配则回退到 basename，空白时返回 "file.bin"
 * @param filePath - 媒体文件路径
 * @returns 提取的原始文件名
 */
export function extractOriginalFilename(filePath: string): string {
  const basename = path.basename(filePath);
  if (!basename) {
    return "file.bin"; // 空输入的降级处理
  }

  const ext = path.extname(basename);      // 获取文件扩展名
  const nameWithoutExt = path.basename(basename, ext); // 获取不带扩展名的文件名

  // 检查是否为 ---{uuid} 格式（uuid 格式：8-4-4-4-12 共 36 个字符）
  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`; // 匹配成功，返回原始文件名
  }

  return basename; // 格式不匹配，原样返回
}

// 获取媒体目录路径
export function getMediaDir() {
  return resolveMediaDir();
}

/**
 * 确保媒体目录存在，递归创建
 * @returns 媒体目录路径
 */
export async function ensureMediaDir() {
  const mediaDir = resolveMediaDir();
  // 递归创建目录，权限 0o700（仅所有者可读写执行）
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  return mediaDir;
}

// 判断是否为"路径不存在"错误
function isMissingPathError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * 目录缺失时重新创建后重试
 * 用于处理递归清理可能在 mkdir 和后续文件打开之间删除空目录的竞态条件
 * @param dir - 目录路径
 * @param run - 要执行的异步操作
 * @returns 操作结果
 */
async function retryAfterRecreatingDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isMissingPathError(err)) {
      throw err; // 非路径缺失错误，直接抛出
    }
    // 重新创建目录后重试媒体写入路径
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return await run();
  }
}

/**
 * 清理过期媒体文件
 * @param ttlMs - 生存时间（毫秒），默认 2 分钟
 * @param options - 清理选项
 */
export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  const mediaDir = await ensureMediaDir();
  const now = Date.now();
  const recursive = options.recursive ?? false;
  // 只有递归模式才支持删除空目录
  const pruneEmptyDirs = recursive && (options.pruneEmptyDirs ?? false);

  // 递归清理目录中的过期文件
  const removeExpiredFilesInDir = async (dir: string): Promise<boolean> => {
    const dirEntries = await fs.readdir(dir).catch(() => null);
    if (!dirEntries) {
      return false; // 无法读取目录
    }
    for (const entry of dirEntries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.lstat(fullPath).catch(() => null);
      // 跳过符号链接
      if (!stat || stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        if (recursive) {
          // 递归处理子目录
          const childIsEmpty = await removeExpiredFilesInDir(fullPath);
          if (childIsEmpty) {
            await fs.rmdir(fullPath).catch(() => {}); // 删除空目录
          }
        }
        continue;
      }
      if (!stat.isFile()) {
        continue; // 跳过非文件
      }
      // 检查文件是否过期
      if (now - stat.mtimeMs > ttlMs) {
        await fs.rm(fullPath, { force: true }).catch(() => {});
      }
    }
    if (!pruneEmptyDirs) {
      return false; // 不删除空目录
    }
    const remainingEntries = await fs.readdir(dir).catch(() => null);
    // 目录为空时返回 true
    return remainingEntries !== null && remainingEntries.length === 0;
  };

  // 处理媒体根目录的条目
  const entries = await fs.readdir(mediaDir).catch(() => []);
  for (const file of entries) {
    const full = path.join(mediaDir, file);
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat || stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      // 处理子目录
      const dirIsEmpty = await removeExpiredFilesInDir(full);
      if (dirIsEmpty) {
        await fs.rmdir(full).catch(() => {});
      }
      continue;
    }
    // 检查根目录的过期文件
    if (stat.isFile() && now - stat.mtimeMs > ttlMs) {
      await fs.rm(full, { force: true }).catch(() => {});
    }
  }
}

// 判断字符串是否为 URL
function looksLikeUrl(src: string) {
  return /^https?:\/\//i.test(src);
}

/**
 * 下载媒体到磁盘，同时捕获前几 KB 用于 MIME 类型嗅探
 * @param url - 媒体 URL
 * @param dest - 目标文件路径
 * @param headers - 可选的 HTTP 请求头
 * @param maxRedirects - 最大重定向次数，默认 5
 * @param maxBytes - 最大下载字节数
 * @returns 包含 MIME 类型、嗅探缓冲区和文件大小的结果
 */
async function downloadToFile(
  url: string,
  dest: string,
  headers?: Record<string, string>,
  maxRedirects = 5,
  maxBytes = MAX_BYTES,
): Promise<{ headerMime?: string; sniffBuffer: Buffer; size: number }> {
  return await new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url); // 解析 URL
    } catch {
      reject(new Error("Invalid URL")); // URL 格式无效
      return;
    }
    // 仅支持 HTTP/HTTPS 协议
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      reject(new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`));
      return;
    }
    // 根据协议选择 HTTP 或 HTTPS 请求实现
    const requestImpl = parsedUrl.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
    // 使用 SSRF 防护解析 hostname
    resolvePinnedHostnameImpl(parsedUrl.hostname)
      .then((pinned) => {
        const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, (res) => {
          // 处理 HTTP 重定向（300-399 状态码）
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location;
            if (!location || maxRedirects <= 0) {
              reject(new Error(`Redirect loop or missing Location header`));
              return;
            }
            const redirectUrl = new URL(location, url).href;
            // 跨域重定向时使用安全头部保留策略
            const redirectHeaders =
              new URL(redirectUrl).origin === parsedUrl.origin
                ? headers
                : retainSafeHeadersForCrossOriginRedirect(headers);
            // 递归处理重定向，减少剩余重定向次数
            resolve(downloadToFile(redirectUrl, dest, redirectHeaders, maxRedirects - 1, maxBytes));
            return;
          }
          // 处理错误状态码（400 及以上）
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
            return;
          }
          let total = 0; // 已下载字节数
          const sniffChunks: Buffer[] = []; // 用于 MIME 嗅探的缓冲区
          let sniffLen = 0; // 嗅探缓冲区当前长度
          // 创建可写流，权限 0o644
          const out = createWriteStream(dest, { mode: MEDIA_FILE_MODE });
          res.on("data", (chunk) => {
            total += chunk.length;
            // 保留前 16KB 用于 MIME 嗅探
            if (sniffLen < 16384) {
              sniffChunks.push(chunk);
              sniffLen += chunk.length;
            }
            // 超过最大字节数限制时终止请求
            if (total > maxBytes) {
              req.destroy(new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`));
            }
          });
          // 使用 pipeline 管道将响应流式传输到文件
          pipeline(res, out)
            .then(() => {
              // 合并嗅探缓冲区（最多 16KB）
              const sniffBuffer = Buffer.concat(sniffChunks, Math.min(sniffLen, 16384));
              // 从响应头获取 Content-Type
              const rawHeader = res.headers["content-type"];
              const headerMime = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
              resolve({
                headerMime,
                sniffBuffer,
                size: total,
              });
            })
            .catch(async (err) => {
              // 下载失败时清理临时文件
              await fs.rm(dest, { force: true }).catch(() => {});
              reject(err);
            });
        });
        req.on("error", reject);
        req.end();
      })
      .catch(reject);
  });
}

// 已保存媒体文件的类型定义
export type SavedMedia = {
  id: string;         // 媒体 ID
  path: string;       // 文件路径
  size: number;       // 文件大小（字节）
  contentType?: string; // MIME 类型
};

/**
 * 构建保存媒体文件的 ID
 * 格式：[sanitized_original_filename]---[uuid].[ext] 或 [uuid].[ext]
 * @param params - 构建参数
 * @returns 媒体文件 ID
 */
function buildSavedMediaId(params: {
  baseId: string;         // 基础 UUID
  ext: string;            // 文件扩展名
  originalFilename?: string; // 原始文件名（可选）
}): string {
  if (!params.originalFilename) {
    // 无原始文件名时直接使用 UUID + 扩展名
    return params.ext ? `${params.baseId}${params.ext}` : params.baseId;
  }

  // 从原始文件名提取基础名并清理
  const base = path.parse(params.originalFilename).name;
  const sanitized = sanitizeFilename(base);
  // 使用清理后的文件名作为前缀
  return sanitized
    ? `${sanitized}---${params.baseId}${params.ext}`
    : `${params.baseId}${params.ext}`;
}

/**
 * 获取原始文件名的安全扩展名
 * @param originalFilename - 原始文件名
 * @returns 安全扩展名或 undefined
 */
function safeOriginalFilenameExtension(originalFilename?: string): string | undefined {
  if (!originalFilename) {
    return undefined;
  }
  const ext = path.extname(originalFilename).toLowerCase();
  // 仅接受合理的扩展名格式：点 + 1-16 个字母数字
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

/**
 * 构建保存媒体的结果对象
 * @param params - 结果参数
 * @returns SavedMedia 对象
 */
function buildSavedMediaResult(params: {
  dir: string;
  id: string;
  size: number;
  contentType?: string;
}): SavedMedia {
  return {
    id: params.id,
    path: path.join(params.dir, params.id),
    size: params.size,
    contentType: params.contentType,
  };
}

/**
 * 将缓冲区写入保存的媒体文件
 * @param params - 写入参数
 * @returns 目标文件路径
 */
async function writeSavedMediaBuffer(params: {
  dir: string;
  id: string;
  buffer: Buffer;
}): Promise<string> {
  const dest = path.join(params.dir, params.id);
  // 写入文件，权限 0o644
  await retryAfterRecreatingDir(params.dir, () =>
    fs.writeFile(dest, params.buffer, { mode: MEDIA_FILE_MODE }),
  );
  return dest;
}

// 保存媒体源错误代码类型
export type SaveMediaSourceErrorCode =
  | "invalid-path"      // 无效路径
  | "not-found"         // 文件不存在
  | "not-file"          // 路径不是文件
  | "path-mismatch"     // 路径在读取过程中发生变化
  | "too-large";        // 文件过大

/**
 * 保存媒体源错误类
 * 用于处理从 URL 或本地路径保存媒体时的错误
 */
export class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode; // 错误代码

  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SaveMediaSourceError";
  }
}

/**
 * 将安全打开错误转换为 SaveMediaSourceError
 * @param err - 原始安全打开错误
 * @param maxBytes - 最大字节数限制
 * @returns SaveMediaSourceError 实例
 */
function toSaveMediaSourceError(
  err: SafeOpenLikeError,
  maxBytes = MAX_BYTES,
): SaveMediaSourceError {
  switch (err.code) {
    case "symlink":
      return new SaveMediaSourceError("invalid-path", "Media path must not be a symlink", {
        cause: err,
      });
    case "not-file":
      return new SaveMediaSourceError("not-file", "Media path is not a file", { cause: err });
    case "path-mismatch":
      return new SaveMediaSourceError("path-mismatch", "Media path changed during read", {
        cause: err,
      });
    case "too-large":
      return new SaveMediaSourceError(
        "too-large",
        `Media exceeds ${formatMediaLimitMb(maxBytes)} limit`,
        { cause: err },
      );
    case "not-found":
      return new SaveMediaSourceError("not-found", "Media path does not exist", { cause: err });
    case "outside-workspace":
      return new SaveMediaSourceError("invalid-path", "Media path is outside workspace root", {
        cause: err,
      });
    case "invalid-path":
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

/**
 * 保存媒体源（URL 或本地文件）到媒体目录
 * @param source - 媒体源（URL 或本地路径）
 * @param headers - 可选的 HTTP 请求头
 * @param subdir - 子目录名称，默认为空
 * @param maxBytes - 最大字节数限制
 * @returns 保存的媒体信息
 */
export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
  maxBytes = MAX_BYTES,
): Promise<SavedMedia> {
  const baseDir = resolveMediaDir();
  const dir = subdir ? path.join(baseDir, subdir) : baseDir;
  // 确保目标目录存在
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // 清理旧媒体文件
  await cleanOldMedia(DEFAULT_TTL_MS, { recursive: false });
  const baseId = crypto.randomUUID(); // 生成唯一 ID

  if (looksLikeUrl(source)) {
    // 处理 URL：下载到临时文件
    const tempDest = path.join(dir, `${baseId}.tmp`);
    const { headerMime, sniffBuffer, size } = await retryAfterRecreatingDir(dir, () =>
      downloadToFile(source, tempDest, headers, 5, maxBytes),
    );
    // 检测 MIME 类型
    const mime = await detectMime({
      buffer: sniffBuffer,
      headerMime,
      filePath: source,
    });
    // 确定文件扩展名
    const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
    const id = buildSavedMediaId({ baseId, ext });
    const finalDest = path.join(dir, id);
    // 重命名临时文件为最终文件名
    await fs.rename(tempDest, finalDest);
    return buildSavedMediaResult({ dir, id, size, contentType: mime });
  }

  // 处理本地文件
  try {
    const { buffer, stat } = await readLocalFileSafely({ filePath: source, maxBytes });
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    await writeSavedMediaBuffer({ dir, id, buffer });
    return buildSavedMediaResult({ dir, id, size: stat.size, contentType: mime });
  } catch (err) {
    if (isSafeOpenError(err)) {
      throw toSaveMediaSourceError(err, maxBytes);
    }
    throw err;
  }
}

/**
 * 保存媒体缓冲区到媒体目录
 * @param buffer - 媒体数据缓冲区
 * @param contentType - MIME 类型
 * @param subdir - 子目录名称，默认为 "inbound"
 * @param maxBytes - 最大字节数限制
 * @param originalFilename - 原始文件名（可选）
 * @returns 保存的媒体信息
 */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
): Promise<SavedMedia> {
  // 检查缓冲区大小
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`);
  }
  const dir = path.join(resolveMediaDir(), subdir);
  // 确保子目录存在
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  // 从 Content-Type 提取扩展名
  const headerExt = extensionForMime(normalizeOptionalString(contentType?.split(";")[0]));
  const mime = await detectMime({ buffer, headerMime: contentType });
  // 确定最终扩展名：优先使用 header 扩展名 > MIME 映射 > 原始文件名扩展名
  const ext =
    headerExt ?? extensionForMime(mime) ?? safeOriginalFilenameExtension(originalFilename) ?? "";
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  await writeSavedMediaBuffer({ dir, id, buffer });
  return buildSavedMediaResult({ dir, id, size: buffer.byteLength, contentType: mime });
}

/**
 * 将 saveMediaBuffer 保存的媒体 ID 解析为物理路径
 *
 * 这是 saveMediaBuffer 的读取端对应函数，用于 Gateway 的 claim-check 卸载路径中
 * 水合 agent runner 写入的不透明 `media://inbound/<id>` URI
 *
 * 安全特性：
 * - 拒绝包含路径分隔符、".." 或空字节的 ID，防止目录遍历和路径注入
 * - 验证解析路径是常规文件（不是符号链接或目录），符合写入端 MEDIA_FILE_MODE 策略
 *
 * @param id - 媒体 ID（如 "photo---<uuid>.png" 或 "图片---<uuid>.png"）
 * @param subdir - 子目录，默认为 "inbound"
 * @returns 文件的绝对路径
 * @throws 如果 ID 不安全、文件不存在或不是常规文件
 */
export async function resolveMediaBufferPath(
  id: string,
  subdir: "inbound" = "inbound",
): Promise<string> {
  // 防止路径遍历和空字节注入的检查
  // - 分隔符检查：拒绝包含 "/" 或 "\" 的任何 ID（覆盖 "../foo" 等相对路径遍历）
  // - 精确 ".." 检查：拒绝两个字符的遍历操作符
  // - 空字节检查：拒绝 "\0"，某些平台可能截断路径导致打开意外文件
  // 允许文件名中的连续点（如 "report..draft.png"）
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`resolveMediaBufferPath: unsafe media ID: ${JSON.stringify(id)}`);
  }

  const dir = path.join(resolveMediaDir(), subdir);
  const resolved = path.join(dir, id);

  // 双重检查 path.join 没有逃逸目标目录
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new Error(`resolveMediaBufferPath: path escapes media directory: ${JSON.stringify(id)}`);
  }

  // 使用 lstat（非 stat）以便看到符号链接而不是跟随它
  const stat = await fs.lstat(resolved);

  // 拒绝跟随符号链接
  if (stat.isSymbolicLink()) {
    throw new Error(
      `resolveMediaBufferPath: refusing to follow symlink for media ID: ${JSON.stringify(id)}`,
    );
  }
  // 必须是常规文件
  if (!stat.isFile()) {
    throw new Error(
      `resolveMediaBufferPath: media ID does not resolve to a file: ${JSON.stringify(id)}`,
    );
  }

  return resolved;
}

/**
 * 删除之前保存的媒体缓冲区文件
 *
 * 用于 parseMessageWithAttachments 清理在后续附件验证失败
 * 且整个解析中止时成功卸载的文件，防止孤立文件在定期 TTL 清理之前累积
 *
 * 在删除前使用 resolveMediaBufferPath 应用与读取路径相同的路径安全检查
 *
 * 错误有意不被抑制——希望尽力清理的调用方应自行捕获并丢弃异常
 *
 * @param id - 媒体 ID
 * @param subdir - 子目录，默认为 "inbound"
 */
export async function deleteMediaBuffer(id: string, subdir: "inbound" = "inbound"): Promise<void> {
  const physicalPath = await resolveMediaBufferPath(id, subdir);
  await fs.unlink(physicalPath);
}

// 辅助函数：将字节数格式化为 MB 字符串
function formatMediaLimitMb(maxBytes: number): string {
  return `${(maxBytes / (1024 * 1024)).toFixed(0)}MB`;
}
