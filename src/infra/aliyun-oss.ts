import crypto from "node:crypto";
import fs from "node:fs/promises";
import { loadConfig } from "../config/config.js";

/**
 * Minimal Aliyun OSS uploader for agent file delivery (no `ali-oss` dependency:
 * a single header-signed PUT is all we need). Files land under the bucket's
 * existing `ibtai/assistant-agent/` convention and are served back to web users
 * as permanent public links on the custom domain (e.g. https://oss.ibtai.com).
 */

export interface AliyunOssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  /** Region endpoint host, e.g. "oss-cn-beijing.aliyuncs.com" (no scheme). */
  endpoint: string;
  /** Public base URL for returned links, e.g. "https://oss.ibtai.com". */
  customDomain: string;
  /** Object key prefix, no leading/trailing slash. */
  pathPrefix: string;
  maxFileSizeMb: number;
  /** Lowercase extensions without the dot. */
  allowedExtensions: string[];
}

export const DEFAULT_OSS_PATH_PREFIX = "ibtai/assistant-agent/outputs";

export const DEFAULT_OSS_ALLOWED_EXTENSIONS = [
  "csv",
  "docx",
  "gif",
  "html",
  "jpeg",
  "jpg",
  "json",
  "md",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "pptx",
  "txt",
  "xlsx",
  "zip",
];

const DEFAULT_MAX_FILE_SIZE_MB = 100;

const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Resolve OSS settings from the rabbitmq-consumer plugin entry (the pipeline
 * whose per-user agents deliver files), falling back to ALIYUN_OSS_* env vars.
 * Mirrors the skills-mysql pattern of piggybacking on a plugin config block.
 * Returns null when no credentials are configured (tool stays unavailable).
 */
export function resolveOssConfig(): AliyunOssConfig | null {
  let ossCfg: Record<string, unknown> | undefined;
  try {
    const cfg = loadConfig();
    const pluginEntries = cfg.plugins?.entries as
      | Record<string, Record<string, unknown>>
      | undefined;
    const pluginCfg = pluginEntries?.["rabbitmq-consumer"]?.config as
      | Record<string, unknown>
      | undefined;
    ossCfg = pluginCfg?.oss as Record<string, unknown> | undefined;
  } catch {
    ossCfg = undefined;
  }
  return resolveOssConfigFrom(ossCfg, process.env);
}

/** Pure half of {@link resolveOssConfig}; exported for tests. */
export function resolveOssConfigFrom(
  ossCfg: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
): AliyunOssConfig | null {
  const accessKeyId = (ossCfg?.accessKeyId as string) ?? env.ALIYUN_OSS_ACCESS_KEY_ID ?? "";
  const accessKeySecret =
    (ossCfg?.accessKeySecret as string) ?? env.ALIYUN_OSS_ACCESS_KEY_SECRET ?? "";
  if (!accessKeyId || !accessKeySecret) {
    return null;
  }

  const allowedRaw = ossCfg?.allowedExtensions;
  const allowedExtensions =
    Array.isArray(allowedRaw) && allowedRaw.length > 0
      ? allowedRaw.map((e) => String(e).toLowerCase().replace(/^\./, ""))
      : DEFAULT_OSS_ALLOWED_EXTENSIONS;

  return {
    accessKeyId,
    accessKeySecret,
    bucket: (ossCfg?.bucket as string) ?? env.ALIYUN_OSS_BUCKET ?? "leadingnews",
    endpoint:
      (ossCfg?.endpoint as string) ?? env.ALIYUN_OSS_ENDPOINT ?? "oss-cn-beijing.aliyuncs.com",
    customDomain: (
      (ossCfg?.customDomain as string) ??
      env.ALIYUN_OSS_CUSTOM_DOMAIN ??
      "https://oss.ibtai.com"
    ).replace(/\/+$/, ""),
    pathPrefix: (
      (ossCfg?.pathPrefix as string) ??
      env.ALIYUN_OSS_PATH_PREFIX ??
      DEFAULT_OSS_PATH_PREFIX
    ).replace(/^\/+|\/+$/g, ""),
    maxFileSizeMb: Number(
      ossCfg?.maxFileSizeMb ?? env.ALIYUN_OSS_MAX_FILE_SIZE_MB ?? DEFAULT_MAX_FILE_SIZE_MB,
    ),
    allowedExtensions,
  };
}

/** Lowercase extension without the dot, or "" when the name has none. */
export function fileExtension(filename: string): string {
  const match = /\.([^./\\]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Object key following the bucket's existing assistant-agent convention:
 * `{prefix}/{year}/{month}/{day}/{unixSeconds}_{hex8}.{ext}` — month/day not
 * zero-padded, opaque basename (no user-controlled segments, so no Chinese
 * percent-encoding in shared links and no path injection surface).
 */
export function buildOssObjectKey(pathPrefix: string, extension: string, now = new Date()): string {
  const ts = Math.floor(now.getTime() / 1000);
  const rand = crypto.randomBytes(4).toString("hex");
  const suffix = extension ? `.${extension}` : "";
  return `${pathPrefix}/${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/${ts}_${rand}${suffix}`;
}

/**
 * RFC 6266 Content-Disposition that keeps the user-facing (often Chinese)
 * filename on download while the object key stays opaque. ASCII fallback is the
 * key basename so the header itself never carries non-ASCII bytes.
 */
export function buildContentDisposition(displayName: string, asciiFallback: string): string {
  const encoded = encodeURIComponent(displayName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const safeFallback = asciiFallback.replace(/[^\w.-]/g, "_");
  return `attachment; filename="${safeFallback}"; filename*=UTF-8''${encoded}`;
}

export function contentTypeForExtension(extension: string): string {
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * OSS V1 header-signature string for a PUT with no x-oss-* headers:
 * VERB \n Content-MD5 \n Content-Type \n Date \n /bucket/key
 */
export function buildOssStringToSign(params: {
  verb: string;
  contentMd5: string;
  contentType: string;
  date: string;
  bucket: string;
  objectKey: string;
}): string {
  return [
    params.verb,
    params.contentMd5,
    params.contentType,
    params.date,
    `/${params.bucket}/${params.objectKey}`,
  ].join("\n");
}

export function signOssRequest(accessKeySecret: string, stringToSign: string): string {
  return crypto.createHmac("sha1", accessKeySecret).update(stringToSign, "utf8").digest("base64");
}

export interface OssUploadResult {
  url: string;
  objectKey: string;
  size: number;
}

/**
 * Upload a local file with a V1 header-signed PUT and return its permanent
 * public URL on the custom domain. Throws on HTTP/network failure; the caller
 * decides what surfaces to the model.
 */
export async function uploadFileToOss(params: {
  config: AliyunOssConfig;
  localPath: string;
  /** Download filename shown to the end user (Content-Disposition). */
  displayName: string;
  fetchImpl?: typeof fetch;
}): Promise<OssUploadResult> {
  const { config, localPath, displayName } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  const body = await fs.readFile(localPath);
  const extension = fileExtension(displayName);
  const objectKey = buildOssObjectKey(config.pathPrefix, extension);
  const contentType = contentTypeForExtension(extension);
  const contentMd5 = crypto.createHash("md5").update(body).digest("base64");
  const date = new Date().toUTCString();

  const signature = signOssRequest(
    config.accessKeySecret,
    buildOssStringToSign({
      verb: "PUT",
      contentMd5,
      contentType,
      date,
      bucket: config.bucket,
      objectKey,
    }),
  );

  const keyBasename = objectKey.slice(objectKey.lastIndexOf("/") + 1);
  const url = `https://${config.bucket}.${config.endpoint}/${objectKey}`;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Authorization: `OSS ${config.accessKeyId}:${signature}`,
      "Content-MD5": contentMd5,
      "Content-Type": contentType,
      "Content-Disposition": buildContentDisposition(displayName, keyBasename),
      Date: date,
      "Content-Length": String(body.byteLength),
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OSS upload failed: HTTP ${response.status} ${response.statusText}`);
  }

  return {
    url: `${config.customDomain}/${objectKey}`,
    objectKey,
    size: body.byteLength,
  };
}
