// 引入 Node.js 文件系统和 HTTP 服务器模块
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
// 引入危险操作标记和运行时环境类型
import { danger } from "../globals.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { detectMime } from "./mime.js";
import {
  cleanOldMedia,
  getMediaDir,
  isSafeOpenError,
  MEDIA_MAX_BYTES,
  readFileWithinRoot,
} from "./server.runtime.js";

// 默认 TTL：2 分钟
const DEFAULT_TTL_MS = 2 * 60 * 1000;
// 媒体 ID 最大字符数
const MAX_MEDIA_ID_CHARS = 200;
// 媒体 ID 格式：支持 Unicode 字母数字、点、下划线、连字符
const MEDIA_ID_PATTERN = /^[\p{L}\p{N}._-]+$/u;
// 最大媒体字节数
const MAX_MEDIA_BYTES = MEDIA_MAX_BYTES;
// 默认媒体 Content-Type
const DEFAULT_MEDIA_CONTENT_TYPE = "application/octet-stream";
// 活跃内容 MIME 类型集合（会被设置为 attachment 下载）
const ACTIVE_CONTENT_MIME_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
  "text/xml",
]);

/**
 * 验证媒体 ID 是否有效
 * @param id - 待验证的媒体 ID
 * @returns 是否有效
 */
const isValidMediaId = (id: string) => {
  if (!id) {
    return false; // 空 ID 无效
  }
  if (id.length > MAX_MEDIA_ID_CHARS) {
    return false; // 过长无效
  }
  if (id === "." || id === "..") {
    return false; // 特殊目录名无效
  }
  return MEDIA_ID_PATTERN.test(id); // 格式验证
};

/**
 * 发送文本响应
 * @param res - 响应对象
 * @param statusCode - HTTP 状态码
 * @param body - 响应体文本
 */
function sendText(res: ServerResponse, statusCode: number, body: string): void {
  const data = Buffer.from(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", String(data.byteLength));
  res.end(data);
}

/**
 * 从 HTTP 请求中解析媒体 ID
 * @param req - 传入的 HTTP 请求
 * @returns 解析结果，包含是否匹配路由、媒体 ID 和 HTTP 方法
 */
function resolveMediaId(req: IncomingMessage): {
  routeMatched: boolean;
  id?: string;
  method?: string;
} {
  // 仅支持 GET 和 HEAD 方法
  if (req.method !== "GET" && req.method !== "HEAD") {
    return { routeMatched: false };
  }
  // 解析请求 URL
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const prefix = "/media/";
  // 检查是否匹配媒体路由前缀
  if (!url.pathname.startsWith(prefix)) {
    return { routeMatched: false };
  }
  // 提取媒体 ID 部分
  const encodedId = url.pathname.slice(prefix.length);
  // ID 不能包含路径分隔符
  if (!encodedId || encodedId.includes("/")) {
    return { routeMatched: false };
  }
  try {
    // 解码 URI 组件
    return { routeMatched: true, id: decodeURIComponent(encodedId), method: req.method };
  } catch {
    // 解码失败返回空 ID
    return { routeMatched: true, id: "", method: req.method };
  }
}

/**
 * 判断 MIME 类型是否为活跃内容（会被下载而非直接显示）
 * @param mime - MIME 类型字符串
 * @returns 是否为活跃内容类型
 */
function isActiveContentMime(mime?: string): boolean {
  // 提取并规范化 MIME 类型
  const normalized = mime?.split(";")[0]?.trim().toLowerCase();
  return normalized ? ACTIVE_CONTENT_MIME_TYPES.has(normalized) : false;
}

/**
 * 清理并转义附件文件名
 * 移除引号、反斜杠、回车等不安全字符
 * @param id - 原始 ID
 * @returns 安全的文件名
 */
function sanitizeAttachmentFilename(id: string): string {
  const name = id.replace(/["\\\r\n]/g, "_").trim();
  return name || "media"; // 空时使用默认值
}

/**
 * 设置媒体响应的 HTTP 头
 * @param res - 响应对象
 * @param params - 参数对象（ID、MIME 类型、字节数）
 */
function setMediaHeaders(
  res: ServerResponse,
  params: { id: string; mime?: string; bytes: number },
): void {
  const activeContent = isActiveContentMime(params.mime);
  // 活跃内容使用默认类型并作为附件下载
  res.setHeader(
    "Content-Type",
    activeContent ? DEFAULT_MEDIA_CONTENT_TYPE : (params.mime ?? DEFAULT_MEDIA_CONTENT_TYPE),
  );
  res.setHeader("Content-Length", String(params.bytes));
  // 活跃内容设置 Content-Disposition 头
  if (activeContent) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeAttachmentFilename(params.id)}"`,
    );
  }
}

/**
 * 安排媒体文件清理
 * @param realPath - 要清理的文件路径
 */
function scheduleMediaCleanup(realPath: string): void {
  const cleanup = () => {
    // 异步删除文件，忽略错误
    void fs.rm(realPath).catch(() => {});
  };
  // Vitest 环境中使用微任务快速清理
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    queueMicrotask(cleanup);
    return;
  }
  // 生产环境延迟 50ms 后清理
  setTimeout(cleanup, 50);
}

/**
 * 在响应结束后安排文件清理
 * 监听 finish、close、error 事件，任一发生时安排清理
 * @param res - 响应对象
 * @param realPath - 要清理的文件路径
 */
function cleanupAfterGetResponse(res: ServerResponse, realPath: string): void {
  let scheduled = false; // 确保只安排一次清理
  const scheduleOnce = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    scheduleMediaCleanup(realPath);
  };
  // 监听响应结束事件
  res.once("finish", scheduleOnce);
  res.once("close", scheduleOnce);
  res.once("error", scheduleOnce);
}

/**
 * 创建媒体请求处理器
 * @param ttlMs - 媒体文件 TTL（毫秒）
 * @returns HTTP 请求处理器函数
 */
export function createMediaRequestHandler(ttlMs = DEFAULT_TTL_MS) {
  const mediaDir = getMediaDir();

  return (req: IncomingMessage, res: ServerResponse) => {
    const route = resolveMediaId(req);
    // 不匹配路由返回 404
    if (!route.routeMatched) {
      sendText(res, 404, "not found");
      return;
    }

    void (async () => {
      // 设置安全响应头，防止 MIME 类型嗅探
      res.setHeader("X-Content-Type-Options", "nosniff");
      const id = route.id ?? "";
      // 验证媒体 ID
      if (!isValidMediaId(id)) {
        sendText(res, 400, "invalid path");
        return;
      }
      try {
        // 在媒体目录内读取文件
        const {
          buffer: data,
          realPath,
          stat,
        } = await readFileWithinRoot({
          rootDir: mediaDir,
          relativePath: id,
          maxBytes: MAX_MEDIA_BYTES,
        });
        // 检查文件是否过期
        if (Date.now() - stat.mtimeMs > ttlMs) {
          await fs.rm(realPath).catch(() => {});
          sendText(res, 410, "expired"); // 资源已过期
          return;
        }
        // 检测 MIME 类型
        const mime = await detectMime({ buffer: data, filePath: realPath });
        // 设置响应头
        setMediaHeaders(res, { id, mime, bytes: data.byteLength });
        res.statusCode = 200;
        // HEAD 请求只返回头部
        if (route.method === "HEAD") {
          res.end();
          return;
        }
        // 响应结束后清理文件
        cleanupAfterGetResponse(res, realPath);
        // 检查请求是否已中止
        if (req.aborted || res.destroyed || res.writableEnded) {
          scheduleMediaCleanup(realPath);
          return;
        }
        // 发送数据
        res.end(data);
      } catch (err) {
        if (isSafeOpenError(err)) {
          // 处理各种安全打开错误
          if (err.code === "outside-workspace") {
            sendText(res, 400, "file is outside workspace root");
            return;
          }
          if (err.code === "invalid-path") {
            sendText(res, 400, "invalid path");
            return;
          }
          if (err.code === "not-found") {
            sendText(res, 404, "not found");
            return;
          }
          if (err.code === "too-large") {
            sendText(res, 413, "too large");
            return;
          }
        }
        // 未知错误返回 404
        sendText(res, 404, "not found");
      }
    })().catch(() => {
      // 异步处理中的未捕获错误
      if (!res.headersSent) {
        sendText(res, 404, "not found");
      } else {
        res.destroy(); // 已开始发送则销毁连接
      }
    });
  };
}

/**
 * 启动定期媒体清理间隔
 * @param ttlMs - 清理间隔（毫秒）
 */
function startMediaCleanupInterval(ttlMs: number): void {
  // 定期执行清理，间隔为 TTL
  setInterval(() => {
    void cleanOldMedia(ttlMs, { recursive: false });
  }, ttlMs).unref(); // 允许进程退出
}

/**
 * 启动媒体服务器
 * @param port - 监听端口
 * @param ttlMs - 媒体文件 TTL
 * @param runtime - 运行时环境
 * @returns HTTP 服务器实例
 */
export async function startMediaServer(
  port: number,
  ttlMs = DEFAULT_TTL_MS,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<Server> {
  // 创建 HTTP 服务器
  const server = createServer(createMediaRequestHandler(ttlMs));
  // 启动定期清理
  startMediaCleanupInterval(ttlMs);
  // 监听端口，仅监听本地回环地址
  return await new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", (err) => {
      // 记录错误并拒绝
      runtime.error(danger(`Media server failed: ${String(err)}`));
      reject(err);
    });
  });
}
