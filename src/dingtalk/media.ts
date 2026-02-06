import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AICardTarget } from "./ai-card.js";
import { getDingTalkAccessToken } from "./auth.js";
import { loadDingTalkAxios, loadDingTalkFormData, loadFfmpegInstaller } from "./deps.js";

const ffmpegInstaller = loadFfmpegInstaller();
const axios = loadDingTalkAxios();
const FormData = loadDingTalkFormData();

/**
 * 匹配 markdown 图片中的本地文件路径（跨平台）：
 * - ![alt](file:///path/to/image.jpg)
 * - ![alt](MEDIA:/var/folders/xxx.jpg)
 * - ![alt](attachment:///path.jpg)
 * macOS:
 * - ![alt](/tmp/xxx.jpg)
 * - ![alt](/var/folders/xxx.jpg)
 * - ![alt](/Users/xxx/photo.jpg)
 * Linux:
 * - ![alt](/home/user/photo.jpg)
 * - ![alt](/root/photo.jpg)
 * Windows:
 * - ![alt](C:\Users\xxx\photo.jpg)
 * - ![alt](C:/Users/xxx/photo.jpg)
 */
const LOCAL_IMAGE_RE =
  /!\[([^\]]*)\]\(((?:file:\/\/\/|MEDIA:|attachment:\/\/\/)[^)]+|\/(?:tmp|var|private|Users|home|root)[^)]+|[A-Za-z]:[\\/ ][^)]+)\)/g;

/** 图片文件扩展名 */
export const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|bmp|webp|tiff|svg)$/i;

/**
 * 匹配纯文本中的本地图片路径（不在 markdown 图片语法中，跨平台）：
 * macOS:
 * - `/var/folders/.../screenshot.png`
 * - `/tmp/image.jpg`
 * - `/Users/xxx/photo.png`
 * Linux:
 * - `/home/user/photo.png`
 * - `/root/photo.png`
 * Windows:
 * - `C:\Users\xxx\photo.png`
 * - `C:/temp/image.jpg`
 * 支持 backtick 包裹: `path`
 */
const BARE_IMAGE_PATH_RE =
  /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))`?/gi;

/** 去掉 file:// / MEDIA: / attachment:// 前缀，得到实际的绝对路径 */
function toLocalPath(raw: string): string {
  let value = raw;
  if (value.startsWith("file://")) {
    value = value.replace("file://", "");
  } else if (value.startsWith("MEDIA:")) {
    value = value.replace("MEDIA:", "");
  } else if (value.startsWith("attachment://")) {
    value = value.replace("attachment://", "");
  }

  // 解码 URL 编码的路径（如中文字符 %E5%9B%BE → 图）
  try {
    value = decodeURIComponent(value);
  } catch {
    // 解码失败则保持原样
  }
  return value;
}

export const FILE_MARKER_PATTERN = /\[DINGTALK_FILE\]({.*?})\[\/DINGTALK_FILE\]/g;
export const VIDEO_MARKER_PATTERN = /\[DINGTALK_VIDEO\]({.*?})\[\/DINGTALK_VIDEO\]/g;
export const AUDIO_MARKER_PATTERN = /\[DINGTALK_AUDIO\]({.*?})\[\/DINGTALK_AUDIO\]/g;

/** 视频大小限制：20MB */
const MAX_VIDEO_SIZE = 20 * 1024 * 1024;
/** 文件大小限制：20MB（字节） */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** 音频文件扩展名 */
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "amr", "ogg", "aac", "flac", "m4a"]);

/** 判断是否为音频文件 */
function isAudioFile(fileType: string): boolean {
  return AUDIO_EXTENSIONS.has(fileType.toLowerCase());
}

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function resolveFfprobePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timeout: ${command}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** 视频信息接口 */
type VideoInfo = {
  path: string;
};

/** 视频元数据接口 */
type VideoMetadata = {
  duration: number;
  width: number;
  height: number;
};

/** 文件信息接口 */
type FileInfo = {
  path: string;
  fileName: string;
  fileType: string;
};

/** 音频信息接口 */
type AudioInfo = {
  path: string;
};

export function buildDingTalkMediaSystemPrompt(): string {
  return `## 钉钉图片和文件显示规则

你正在钉钉中与用户对话。

### 一、图片显示

显示图片时，直接使用本地文件路径，系统会自动上传处理。

**正确方式**：
\`\`\`markdown
![描述](file:///path/to/image.jpg)
![描述](/tmp/screenshot.png)
![描述](/Users/xxx/photo.jpg)
\`\`\`

**禁止**：
- 不要自己执行 curl 上传
- 不要猜测或构造 URL
- **不要对路径进行转义（如使用反斜杠 \\ ）**

直接输出本地路径即可，系统会自动上传到钉钉。

### 二、视频分享

**何时分享视频**：
- ✅ 用户明确要求**分享、发送、上传**视频时
- ❌ 仅生成视频保存到本地时，**不需要**分享

**视频标记格式**：
当需要分享视频时，在回复**末尾**添加：

\`\`\`
[DINGTALK_VIDEO]{"path":"<本地视频路径>"}[/DINGTALK_VIDEO]
\`\`\`

**支持格式**：mp4（最大 20MB）

**重要**：
- 视频大小不得超过 20MB，超过限制时告知用户
- 仅支持 mp4 格式
- 系统会自动提取视频时长、分辨率并生成封面

### 三、音频分享

**何时分享音频**：
- ✅ 用户明确要求**分享、发送、上传**音频/语音文件时
- ❌ 仅生成音频保存到本地时，**不需要**分享

**音频标记格式**：
当需要分享音频时，在回复**末尾**添加：

\`\`\`
[DINGTALK_AUDIO]{"path":"<本地音频路径>"}[/DINGTALK_AUDIO]
\`\`\`

**支持格式**：ogg、amr（最大 20MB）

**重要**：
- 音频大小不得超过 20MB，超过限制时告知用户
- 系统会自动提取音频时长

### 四、文件分享

**何时分享文件**：
- ✅ 用户明确要求**分享、发送、上传**文件时
- ❌ 仅生成文件保存到本地时，**不需要**分享

**文件标记格式**：
当需要分享文件时，在回复**末尾**添加：

\`\`\`
[DINGTALK_FILE]{"path":"<本地文件路径>","fileName":"<文件名>","fileType":"<扩展名>"}[/DINGTALK_FILE]
\`\`\`

**支持的文件类型**：几乎所有常见格式

**重要**：文件大小不得超过 20MB，超过限制时告知用户文件过大。`;
}

/**
 * 通用媒体文件上传函数
 * @param filePath 文件路径
 * @param mediaType 媒体类型：image, file, video, voice
 * @param oapiToken 钉钉 access_token
 * @param maxSize 最大文件大小（字节），默认 20MB
 * @param log 日志对象
 * @returns media_id 或 null
 */
export async function uploadMediaToDingTalk(
  filePath: string,
  mediaType: "image" | "file" | "video" | "voice",
  oapiToken: string,
  maxSize: number = 20 * 1024 * 1024,
  log?: Logger,
): Promise<string | null> {
  try {
    const absPath = toLocalPath(filePath);
    if (!fs.existsSync(absPath)) {
      log?.warn?.(`[DingTalk][${mediaType}] 文件不存在: ${absPath}`);
      return null;
    }

    // 检查文件大小
    const stats = fs.statSync(absPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    if (stats.size > maxSize) {
      const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(0);
      log?.warn?.(
        `[DingTalk][${mediaType}] 文件过大: ${absPath}, 大小: ${fileSizeMB}MB, 超过限制 ${maxSizeMB}MB`,
      );
      return null;
    }

    const form = new FormData();
    form.append("media", fs.createReadStream(absPath), {
      filename: path.basename(absPath),
      contentType: mediaType === "image" ? "image/jpeg" : "application/octet-stream",
    });

    log?.info?.(`[DingTalk][${mediaType}] 上传文件: ${absPath} (${fileSizeMB}MB)`);
    const resp = await axios.post(
      `https://oapi.dingtalk.com/media/upload?access_token=${oapiToken}&type=${mediaType}`,
      form,
      { headers: form.getHeaders(), timeout: 60_000 },
    );

    const mediaId = resp.data?.media_id;
    if (mediaId) {
      log?.info?.(`[DingTalk][${mediaType}] 上传成功: media_id=${mediaId}`);
      return mediaId;
    }
    log?.warn?.(`[DingTalk][${mediaType}] 上传返回无 media_id: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][${mediaType}] 上传失败: ${getErrorMessage(err)}`);
    return null;
  }
}

/** 扫描内容中的本地图片路径，上传到钉钉并替换为 media_id */
export async function processLocalImages(
  content: string,
  oapiToken: string | null,
  log?: Logger,
): Promise<string> {
  if (!oapiToken) {
    log?.warn?.(`[DingTalk][Media] 无 oapiToken，跳过图片后处理`);
    return content;
  }

  let result = content;

  // 第一步：匹配 markdown 图片语法 ![alt](path)
  const mdMatches = [...content.matchAll(LOCAL_IMAGE_RE)];
  if (mdMatches.length > 0) {
    log?.info?.(`[DingTalk][Media] 检测到 ${mdMatches.length} 个 markdown 图片，开始上传...`);
    for (const match of mdMatches) {
      const [fullMatch, alt, rawPath] = match;
      // 清理转义字符（AI 可能会对含空格的路径添加 \ ）
      const cleanPath = rawPath.replace(/\\ /g, " ");
      const mediaId = await uploadMediaToDingTalk(
        cleanPath,
        "image",
        oapiToken,
        20 * 1024 * 1024,
        log,
      );
      if (mediaId) {
        result = result.replace(fullMatch, `![${alt}](${mediaId})`);
      }
    }
  }

  // 第二步：匹配纯文本中的本地图片路径（如 `/var/folders/.../xxx.png`）
  // 排除已被 markdown 图片语法包裹的路径
  const bareMatches = [...result.matchAll(BARE_IMAGE_PATH_RE)];
  const newBareMatches = bareMatches.filter((match) => {
    // 检查这个路径是否已经在 ![...](...) 中
    const idx = match.index ?? 0;
    const before = result.slice(Math.max(0, idx - 10), idx);
    return !before.includes("](");
  });

  if (newBareMatches.length > 0) {
    log?.info?.(`[DingTalk][Media] 检测到 ${newBareMatches.length} 个纯文本图片路径，开始上传...`);
    // 从后往前替换，避免 index 偏移
    for (const match of newBareMatches.toReversed()) {
      const [fullMatch, rawPath] = match;
      log?.info?.(`[DingTalk][Media] 纯文本图片: "${fullMatch}" -> path="${rawPath}"`);
      const mediaId = await uploadMediaToDingTalk(
        rawPath,
        "image",
        oapiToken,
        20 * 1024 * 1024,
        log,
      );
      if (mediaId) {
        const replacement = `![](${mediaId})`;
        const startIndex = match.index ?? 0;
        result =
          result.slice(0, startIndex) + result.slice(startIndex).replace(fullMatch, replacement);
        log?.info?.(`[DingTalk][Media] 替换纯文本路径为图片: ${replacement}`);
      }
    }
  }

  if (mdMatches.length === 0 && newBareMatches.length === 0) {
    log?.info?.(`[DingTalk][Media] 未检测到本地图片路径`);
  }

  return result;
}

/**
 * 提取视频元数据（时长、分辨率）
 */
async function extractVideoMetadata(filePath: string, log?: Logger): Promise<VideoMetadata | null> {
  try {
    const ffmpegPath = ffmpegInstaller.path;
    const ffprobePath = resolveFfprobePath(ffmpegPath);
    const { stdout, stderr, code } = await runCommand(
      ffprobePath,
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath],
      15_000,
    );
    if (code !== 0) {
      log?.error?.(`[DingTalk][Video] ffprobe 失败: ${stderr.trim() || "unknown error"}`);
      return null;
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(stdout);
    } catch (err: unknown) {
      log?.error?.(`[DingTalk][Video] 解析元数据失败: ${getErrorMessage(err)}`);
      return null;
    }

    const metadataRecord = toRecord(metadata);
    const streams = Array.isArray(metadataRecord?.streams) ? metadataRecord.streams : [];
    const videoStream = streams.find((stream) => {
      const streamRecord = toRecord(stream);
      return streamRecord?.codec_type === "video";
    });
    const videoStreamRecord = toRecord(videoStream);
    if (!videoStreamRecord) {
      log?.warn?.(`[DingTalk][Video] 未找到视频流`);
      return null;
    }

    const formatRecord = toRecord(metadataRecord?.format);
    const durationRaw = Number(formatRecord?.duration ?? videoStreamRecord.duration ?? 0);
    const duration = Number.isFinite(durationRaw) ? Math.floor(durationRaw) : 0;
    const width = Number(videoStreamRecord.width ?? 0) || 0;
    const height = Number(videoStreamRecord.height ?? 0) || 0;

    log?.info?.(`[DingTalk][Video] 元数据: duration=${duration}s, ${width}x${height}`);
    return { duration, width, height };
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][Video] ffprobe 失败: ${getErrorMessage(err)}`);
    return null;
  }
}

/**
 * 生成视频封面图（第1秒截图）
 */
async function extractVideoThumbnail(
  videoPath: string,
  outputPath: string,
  log?: Logger,
): Promise<string | null> {
  try {
    const ffmpegPath = ffmpegInstaller.path;
    const { stderr, code } = await runCommand(
      ffmpegPath,
      [
        "-y",
        "-loglevel",
        "error",
        "-ss",
        "1",
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=-1:360",
        outputPath,
      ],
      30_000,
    );
    if (code !== 0) {
      log?.error?.(`[DingTalk][Video] 封面生成失败: ${stderr.trim() || "unknown error"}`);
      return null;
    }
    log?.info?.(`[DingTalk][Video] 封面生成成功: ${outputPath}`);
    return outputPath;
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][Video] ffmpeg 失败: ${getErrorMessage(err)}`);
    return null;
  }
}

/**
 * 发送视频消息到钉钉
 */
async function sendVideoMessage(
  _config: { clientId: string; clientSecret: string },
  sessionWebhook: string,
  videoInfo: VideoInfo,
  videoMediaId: string,
  picMediaId: string,
  metadata: VideoMetadata,
  oapiToken: string,
  log?: Logger,
): Promise<void> {
  try {
    const fileName = path.basename(videoInfo.path);

    const payload = {
      msgtype: "video",
      video: {
        duration: metadata.duration.toString(),
        videoMediaId,
        videoType: "mp4",
        picMediaId,
      },
    };

    log?.info?.(`[DingTalk][Video] 发送视频消息: ${fileName}, payload: ${JSON.stringify(payload)}`);
    const resp = await axios.post(sessionWebhook, payload, {
      headers: {
        "x-acs-dingtalk-access-token": oapiToken,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });

    if (resp.data?.success !== false) {
      log?.info?.(`[DingTalk][Video] 视频消息发送成功: ${fileName}`);
    } else {
      log?.error?.(`[DingTalk][Video] 视频消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][Video] 发送失败: ${getErrorMessage(err)}`);
  }
}

/**
 * 视频后处理主函数
 * 返回移除标记后的内容，并附带视频处理的状态提示
 *
 * @param useProactiveApi 是否使用主动消息 API（用于 AI Card 场景）
 * @param target 主动 API 需要的目标信息（useProactiveApi=true 时必须提供）
 */
export async function processVideoMarkers(
  content: string,
  sessionWebhook: string,
  config: { clientId: string; clientSecret: string },
  oapiToken: string | null,
  log?: Logger,
  useProactiveApi: boolean = false,
  target?: AICardTarget,
): Promise<string> {
  const logPrefix = useProactiveApi ? "[DingTalk][Video][Proactive]" : "[DingTalk][Video]";

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过视频处理`);
    return content;
  }

  // 提取视频标记
  const matches = [...content.matchAll(VIDEO_MARKER_PATTERN)];
  const videoInfos: VideoInfo[] = [];
  const invalidVideos: string[] = [];

  for (const match of matches) {
    try {
      const videoInfo = JSON.parse(match[1]) as VideoInfo;
      if (videoInfo.path && fs.existsSync(videoInfo.path)) {
        videoInfos.push(videoInfo);
        log?.info?.(`${logPrefix} 提取到视频: ${videoInfo.path}`);
      } else {
        invalidVideos.push(videoInfo.path || "未知路径");
        log?.warn?.(`${logPrefix} 视频文件不存在: ${videoInfo.path}`);
      }
    } catch (err: unknown) {
      log?.warn?.(`${logPrefix} 解析标记失败: ${getErrorMessage(err)}`);
    }
  }

  if (videoInfos.length === 0 && invalidVideos.length === 0) {
    log?.info?.(`${logPrefix} 未检测到视频标记`);
    return content.replace(VIDEO_MARKER_PATTERN, "").trim();
  }

  // 先移除所有视频标记，保留其他文本内容
  let cleanedContent = content.replace(VIDEO_MARKER_PATTERN, "").trim();

  // 收集处理结果状态
  const statusMessages: string[] = [];

  // 处理无效视频
  for (const invalidPath of invalidVideos) {
    statusMessages.push(`⚠️ 视频文件不存在: ${path.basename(invalidPath)}`);
  }

  if (videoInfos.length > 0) {
    log?.info?.(`${logPrefix} 检测到 ${videoInfos.length} 个视频，开始处理...`);
  }

  // 逐个处理视频
  for (const videoInfo of videoInfos) {
    const fileName = path.basename(videoInfo.path);
    let thumbnailPath = "";
    try {
      // 1. 提取元数据
      const metadata = await extractVideoMetadata(videoInfo.path, log);
      if (!metadata) {
        log?.warn?.(`${logPrefix} 无法提取元数据: ${videoInfo.path}`);
        statusMessages.push(
          `⚠️ 视频处理失败: ${fileName}（无法读取视频信息，请检查 ffmpeg 是否已安装）`,
        );
        continue;
      }

      // 2. 生成封面
      thumbnailPath = path.join(os.tmpdir(), `thumbnail_${Date.now()}.jpg`);
      const thumbnail = await extractVideoThumbnail(videoInfo.path, thumbnailPath, log);
      if (!thumbnail) {
        log?.warn?.(`${logPrefix} 无法生成封面: ${videoInfo.path}`);
        statusMessages.push(`⚠️ 视频处理失败: ${fileName}（无法生成封面）`);
        continue;
      }

      // 3. 上传视频
      const videoMediaId = await uploadMediaToDingTalk(
        videoInfo.path,
        "video",
        oapiToken,
        MAX_VIDEO_SIZE,
        log,
      );
      if (!videoMediaId) {
        log?.warn?.(`${logPrefix} 视频上传失败: ${videoInfo.path}`);
        statusMessages.push(`⚠️ 视频上传失败: ${fileName}（文件可能超过 20MB 限制）`);
        continue;
      }

      // 4. 上传封面
      const picMediaId = await uploadMediaToDingTalk(
        thumbnailPath,
        "image",
        oapiToken,
        20 * 1024 * 1024,
        log,
      );
      if (!picMediaId) {
        log?.warn?.(`${logPrefix} 封面上传失败: ${thumbnailPath}`);
        statusMessages.push(`⚠️ 视频封面上传失败: ${fileName}`);
        continue;
      }

      // 5. 发送视频消息
      if (useProactiveApi && target) {
        await sendVideoProactive(config, target, videoMediaId, picMediaId, metadata, log);
      } else {
        await sendVideoMessage(
          config,
          sessionWebhook,
          videoInfo,
          videoMediaId,
          picMediaId,
          metadata,
          oapiToken,
          log,
        );
      }

      log?.info?.(`${logPrefix} 视频处理完成: ${fileName}`);
      statusMessages.push(`✅ 视频已发送: ${fileName}`);
    } catch (err: unknown) {
      log?.error?.(`${logPrefix} 处理视频失败: ${getErrorMessage(err)}`);
      statusMessages.push(`⚠️ 视频处理异常: ${fileName}（${getErrorMessage(err)}）`);
    } finally {
      // 统一清理临时文件
      if (thumbnailPath) {
        try {
          fs.unlinkSync(thumbnailPath);
        } catch {
          // 文件可能不存在，忽略删除错误
        }
      }
    }
  }

  // 将状态信息附加到清理后的内容
  if (statusMessages.length > 0) {
    const statusText = statusMessages.join("\n");
    cleanedContent = cleanedContent ? `${cleanedContent}\n\n${statusText}` : statusText;
  }

  return cleanedContent;
}

/**
 * 从内容中提取文件标记
 * @returns { cleanedContent, fileInfos }
 */
function extractFileMarkers(
  content: string,
  log?: Logger,
): { cleanedContent: string; fileInfos: FileInfo[] } {
  const fileInfos: FileInfo[] = [];
  const matches = [...content.matchAll(FILE_MARKER_PATTERN)];

  for (const match of matches) {
    try {
      const fileInfo = JSON.parse(match[1]) as FileInfo;

      // 验证必需字段
      if (fileInfo.path && fileInfo.fileName) {
        fileInfos.push(fileInfo);
        log?.info?.(`[DingTalk][File] 提取到文件标记: ${fileInfo.fileName}`);
      }
    } catch (err: unknown) {
      log?.warn?.(`[DingTalk][File] 解析文件标记失败: ${match[1]}, 错误: ${getErrorMessage(err)}`);
    }
  }

  // 移除文件标记，返回清理后的内容
  const cleanedContent = content.replace(FILE_MARKER_PATTERN, "").trim();
  return { cleanedContent, fileInfos };
}

/**
 * 发送文件消息到钉钉
 */
async function sendFileMessage(
  _config: { clientId: string; clientSecret: string },
  sessionWebhook: string,
  fileInfo: FileInfo,
  mediaId: string,
  oapiToken: string,
  log?: Logger,
): Promise<void> {
  try {
    const fileMessage = {
      msgtype: "file",
      file: {
        mediaId,
        fileName: fileInfo.fileName,
        fileType: fileInfo.fileType,
      },
    };

    log?.info?.(`[DingTalk][File] 发送文件消息: ${fileInfo.fileName}`);
    const resp = await axios.post(sessionWebhook, fileMessage, {
      headers: {
        "x-acs-dingtalk-access-token": oapiToken,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });

    if (resp.data?.success !== false) {
      log?.info?.(`[DingTalk][File] 文件消息发送成功: ${fileInfo.fileName}`);
    } else {
      log?.error?.(`[DingTalk][File] 文件消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: unknown) {
    log?.error?.(
      `[DingTalk][File] 发送文件消息异常: ${fileInfo.fileName}, 错误: ${getErrorMessage(err)}`,
    );
  }
}

/**
 * 发送音频消息到钉钉（被动回复场景）
 */
async function sendAudioMessage(
  _config: { clientId: string; clientSecret: string },
  sessionWebhook: string,
  fileInfo: FileInfo,
  mediaId: string,
  oapiToken: string,
  log?: Logger,
): Promise<void> {
  try {
    // 钉钉语音消息格式
    const audioMessage = {
      msgtype: "voice",
      voice: {
        mediaId,
        duration: "60000", // 默认时长，单位毫秒
      },
    };

    log?.info?.(`[DingTalk][Audio] 发送语音消息: ${fileInfo.fileName}`);
    const resp = await axios.post(sessionWebhook, audioMessage, {
      headers: {
        "x-acs-dingtalk-access-token": oapiToken,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });

    if (resp.data?.success !== false) {
      log?.info?.(`[DingTalk][Audio] 语音消息发送成功: ${fileInfo.fileName}`);
    } else {
      log?.error?.(`[DingTalk][Audio] 语音消息发送失败: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: unknown) {
    log?.error?.(
      `[DingTalk][Audio] 发送语音消息异常: ${fileInfo.fileName}, 错误: ${getErrorMessage(err)}`,
    );
  }
}

/**
 * 处理文件标记：提取、上传、发送独立消息
 * 返回移除标记后的内容，并附带文件处理的状态提示
 *
 * @param useProactiveApi 是否使用主动消息 API（用于 AI Card 场景，避免 sessionWebhook 失效问题）
 * @param target 主动 API 需要的目标信息（useProactiveApi=true 时必须提供）
 */
export async function processFileMarkers(
  content: string,
  sessionWebhook: string,
  config: { clientId: string; clientSecret: string },
  oapiToken: string | null,
  log?: Logger,
  useProactiveApi: boolean = false,
  target?: AICardTarget,
): Promise<string> {
  if (!oapiToken) {
    log?.warn?.(`[DingTalk][File] 无 oapiToken，跳过文件处理`);
    return content;
  }

  const { cleanedContent, fileInfos } = extractFileMarkers(content, log);

  if (fileInfos.length === 0) {
    log?.info?.(`[DingTalk][File] 未检测到文件标记`);
    return cleanedContent;
  }

  log?.info?.(
    `[DingTalk][File] 检测到 ${fileInfos.length} 个文件标记，开始处理... (useProactiveApi=${useProactiveApi})`,
  );

  const statusMessages: string[] = [];

  // 逐个上传并发送文件消息
  for (const fileInfo of fileInfos) {
    // 预检查：文件是否存在、是否超限
    const absPath = toLocalPath(fileInfo.path);
    if (!fs.existsSync(absPath)) {
      statusMessages.push(`⚠️ 文件不存在: ${fileInfo.fileName}`);
      continue;
    }
    const stats = fs.statSync(absPath);
    if (stats.size > MAX_FILE_SIZE) {
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
      const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
      statusMessages.push(
        `⚠️ 文件过大无法发送: ${fileInfo.fileName}（${sizeMB}MB，限制 ${maxMB}MB）`,
      );
      continue;
    }

    // 区分音频文件和普通文件
    if (isAudioFile(fileInfo.fileType)) {
      // 音频文件使用 voice 类型上传
      const mediaId = await uploadMediaToDingTalk(
        fileInfo.path,
        "voice",
        oapiToken,
        MAX_FILE_SIZE,
        log,
      );
      if (mediaId) {
        if (useProactiveApi && target) {
          // 使用主动消息 API（适用于 AI Card 场景）
          await sendAudioProactive(config, target, fileInfo, mediaId, log);
        } else {
          // 使用 sessionWebhook（传统被动回复场景）
          await sendAudioMessage(config, sessionWebhook, fileInfo, mediaId, oapiToken, log);
        }
        statusMessages.push(`✅ 音频已发送: ${fileInfo.fileName}`);
      } else {
        log?.error?.(`[DingTalk][Audio] 音频上传失败，跳过发送: ${fileInfo.fileName}`);
        statusMessages.push(`⚠️ 音频上传失败: ${fileInfo.fileName}`);
      }
    } else {
      // 普通文件
      const mediaId = await uploadMediaToDingTalk(
        fileInfo.path,
        "file",
        oapiToken,
        MAX_FILE_SIZE,
        log,
      );
      if (mediaId) {
        if (useProactiveApi && target) {
          // 使用主动消息 API（适用于 AI Card 场景）
          await sendFileProactive(config, target, fileInfo, mediaId, log);
        } else {
          // 使用 sessionWebhook（传统被动回复场景）
          await sendFileMessage(config, sessionWebhook, fileInfo, mediaId, oapiToken, log);
        }
        statusMessages.push(`✅ 文件已发送: ${fileInfo.fileName}`);
      } else {
        log?.error?.(`[DingTalk][File] 文件上传失败，跳过发送: ${fileInfo.fileName}`);
        statusMessages.push(`⚠️ 文件上传失败: ${fileInfo.fileName}`);
      }
    }
  }

  // 将状态信息附加到清理后的内容
  if (statusMessages.length > 0) {
    const statusText = statusMessages.join("\n");
    return cleanedContent ? `${cleanedContent}\n\n${statusText}` : statusText;
  }

  return cleanedContent;
}

/**
 * 主动发送文件消息（使用普通消息 API）
 */
export async function sendFileProactive(
  config: { clientId: string; clientSecret: string },
  target: AICardTarget,
  fileInfo: FileInfo,
  mediaId: string,
  log?: Logger,
): Promise<void> {
  try {
    const token = await getDingTalkAccessToken(config);

    // 钉钉普通消息 API 的文件消息格式
    const msgParam = {
      mediaId,
      fileName: fileInfo.fileName,
      fileType: fileInfo.fileType,
    };

    const body: Record<string, unknown> = {
      robotCode: config.clientId,
      msgKey: "sampleFile",
      msgParam: JSON.stringify(msgParam),
    };

    let endpoint: string;
    if (target.type === "group") {
      body.openConversationId = target.openConversationId;
      endpoint = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
    } else {
      body.userIds = [target.userId];
      endpoint = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
    }

    log?.info?.(`[DingTalk][File][Proactive] 发送文件消息: ${fileInfo.fileName}`);
    const resp = await axios.post(endpoint, body, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      timeout: 10_000,
    });

    if (resp.data?.processQueryKey) {
      log?.info?.(`[DingTalk][File][Proactive] 文件消息发送成功: ${fileInfo.fileName}`);
    } else {
      log?.warn?.(`[DingTalk][File][Proactive] 文件消息发送响应异常: ${JSON.stringify(resp.data)}`);
    }
  } catch (err: unknown) {
    log?.error?.(
      `[DingTalk][File][Proactive] 发送文件消息失败: ${fileInfo.fileName}, 错误: ${getErrorMessage(err)}`,
    );
  }
}

/**
 * 主动发送音频消息（使用普通消息 API）
 */
export async function sendAudioProactive(
  config: { clientId: string; clientSecret: string },
  target: AICardTarget,
  fileInfo: FileInfo,
  mediaId: string,
  log?: Logger,
): Promise<void> {
  try {
    const token = await getDingTalkAccessToken(config);

    // 钉钉普通消息 API 的音频消息格式
    const msgParam = {
      mediaId,
      duration: "60000", // 默认时长，单位毫秒
    };

    const body: Record<string, unknown> = {
      robotCode: config.clientId,
      msgKey: "sampleAudio",
      msgParam: JSON.stringify(msgParam),
    };

    let endpoint: string;
    if (target.type === "group") {
      body.openConversationId = target.openConversationId;
      endpoint = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
    } else {
      body.userIds = [target.userId];
      endpoint = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
    }

    log?.info?.(`[DingTalk][Audio][Proactive] 发送音频消息: ${fileInfo.fileName}`);
    const resp = await axios.post(endpoint, body, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      timeout: 10_000,
    });

    if (resp.data?.processQueryKey) {
      log?.info?.(`[DingTalk][Audio][Proactive] 音频消息发送成功: ${fileInfo.fileName}`);
    } else {
      log?.warn?.(
        `[DingTalk][Audio][Proactive] 音频消息发送响应异常: ${JSON.stringify(resp.data)}`,
      );
    }
  } catch (err: unknown) {
    log?.error?.(
      `[DingTalk][Audio][Proactive] 发送音频消息失败: ${fileInfo.fileName}, 错误: ${getErrorMessage(err)}`,
    );
  }
}

/**
 * 主动发送视频消息（使用普通消息 API）
 */
export async function sendVideoProactive(
  config: { clientId: string; clientSecret: string },
  target: AICardTarget,
  videoMediaId: string,
  picMediaId: string,
  metadata: VideoMetadata,
  log?: Logger,
): Promise<void> {
  try {
    const token = await getDingTalkAccessToken(config);

    // 钉钉普通消息 API 的视频消息格式
    const msgParam = {
      duration: metadata.duration.toString(),
      videoMediaId,
      videoType: "mp4",
      picMediaId,
    };

    const body: Record<string, unknown> = {
      robotCode: config.clientId,
      msgKey: "sampleVideo",
      msgParam: JSON.stringify(msgParam),
    };

    let endpoint: string;
    if (target.type === "group") {
      body.openConversationId = target.openConversationId;
      endpoint = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
    } else {
      body.userIds = [target.userId];
      endpoint = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
    }

    log?.info?.(`[DingTalk][Video][Proactive] 发送视频消息`);
    const resp = await axios.post(endpoint, body, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      timeout: 10_000,
    });

    if (resp.data?.processQueryKey) {
      log?.info?.(`[DingTalk][Video][Proactive] 视频消息发送成功`);
    } else {
      log?.warn?.(
        `[DingTalk][Video][Proactive] 视频消息发送响应异常: ${JSON.stringify(resp.data)}`,
      );
    }
  } catch (err: unknown) {
    log?.error?.(`[DingTalk][Video][Proactive] 发送视频消息失败: ${getErrorMessage(err)}`);
  }
}

/**
 * 提取音频标记并发送音频消息
 * 解析 [DINGTALK_AUDIO]{"path":"..."}[/DINGTALK_AUDIO] 标记
 *
 * @param useProactiveApi 是否使用主动消息 API（用于 AI Card 场景）
 * @param target 主动 API 需要的目标信息（useProactiveApi=true 时必须提供）
 */
export async function processAudioMarkers(
  content: string,
  sessionWebhook: string,
  config: { clientId: string; clientSecret: string },
  oapiToken: string | null,
  log?: Logger,
  useProactiveApi: boolean = false,
  target?: AICardTarget,
): Promise<string> {
  const logPrefix = useProactiveApi ? "[DingTalk][Audio][Proactive]" : "[DingTalk][Audio]";

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过音频处理`);
    return content;
  }

  const matches = [...content.matchAll(AUDIO_MARKER_PATTERN)];
  const audioInfos: AudioInfo[] = [];
  const invalidAudios: string[] = [];

  for (const match of matches) {
    try {
      const audioInfo = JSON.parse(match[1]) as AudioInfo;
      if (audioInfo.path && fs.existsSync(audioInfo.path)) {
        audioInfos.push(audioInfo);
        log?.info?.(`${logPrefix} 提取到音频: ${audioInfo.path}`);
      } else {
        invalidAudios.push(audioInfo.path || "未知路径");
        log?.warn?.(`${logPrefix} 音频文件不存在: ${audioInfo.path}`);
      }
    } catch (err: unknown) {
      log?.warn?.(`${logPrefix} 解析标记失败: ${getErrorMessage(err)}`);
    }
  }

  if (audioInfos.length === 0 && invalidAudios.length === 0) {
    log?.info?.(`${logPrefix} 未检测到音频标记`);
    return content.replace(AUDIO_MARKER_PATTERN, "").trim();
  }

  // 先移除所有音频标记
  let cleanedContent = content.replace(AUDIO_MARKER_PATTERN, "").trim();

  const statusMessages: string[] = [];

  for (const invalidPath of invalidAudios) {
    statusMessages.push(`⚠️ 音频文件不存在: ${path.basename(invalidPath)}`);
  }

  if (audioInfos.length > 0) {
    log?.info?.(`${logPrefix} 检测到 ${audioInfos.length} 个音频，开始处理...`);
  }

  for (const audioInfo of audioInfos) {
    const fileName = path.basename(audioInfo.path);
    try {
      const ext = path.extname(audioInfo.path).slice(1).toLowerCase();

      const fileInfo: FileInfo = {
        path: audioInfo.path,
        fileName,
        fileType: ext,
      };

      // 上传音频到钉钉
      const mediaId = await uploadMediaToDingTalk(
        audioInfo.path,
        "voice",
        oapiToken,
        20 * 1024 * 1024,
        log,
      );
      if (!mediaId) {
        statusMessages.push(`⚠️ 音频上传失败: ${fileName}（文件可能超过 20MB 限制）`);
        continue;
      }

      // 发送音频消息
      if (useProactiveApi && target) {
        await sendAudioProactive(config, target, fileInfo, mediaId, log);
      } else {
        await sendAudioMessage(config, sessionWebhook, fileInfo, mediaId, oapiToken, log);
      }
      statusMessages.push(`✅ 音频已发送: ${fileName}`);
      log?.info?.(`${logPrefix} 音频处理完成: ${fileName}`);
    } catch (err: unknown) {
      log?.error?.(`${logPrefix} 处理音频失败: ${getErrorMessage(err)}`);
      statusMessages.push(`⚠️ 音频处理异常: ${fileName}（${getErrorMessage(err)}）`);
    }
  }

  if (statusMessages.length > 0) {
    const statusText = statusMessages.join("\n");
    cleanedContent = cleanedContent ? `${cleanedContent}\n\n${statusText}` : statusText;
  }

  return cleanedContent;
}
