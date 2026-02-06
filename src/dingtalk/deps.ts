import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type AxiosResponseLike = {
  data: any;
  status?: number;
};

type AxiosClientLike = {
  get: (url: string, config?: Record<string, unknown>) => Promise<AxiosResponseLike>;
  post: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ) => Promise<AxiosResponseLike>;
  put: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>,
  ) => Promise<AxiosResponseLike>;
};

type FormDataLike = {
  append: (name: string, value: unknown, options?: Record<string, unknown>) => void;
  getHeaders: () => Record<string, string>;
};

type FormDataCtor = new () => FormDataLike;

type FfmpegInstallerLike = {
  path: string;
};

type DingTalkStreamClient = {
  registerCallbackListener: (topic: string, callback: (payload: any) => Promise<void>) => void;
  socketCallBackResponse: (messageId: string, body: { success: boolean }) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
};

type DingTalkStreamModuleLike = {
  DWClient: new (options: {
    clientId: string;
    clientSecret: string;
    debug?: boolean;
  }) => DingTalkStreamClient;
  TOPIC_ROBOT: string;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const pluginPackageJsonPath = path.resolve(currentDir, "../../extensions/dingtalk/package.json");

if (!fs.existsSync(pluginPackageJsonPath)) {
  throw new Error(
    "DingTalk plugin package is missing. Ensure extensions/dingtalk exists before enabling DingTalk.",
  );
}

const pluginRequire = createRequire(pluginPackageJsonPath);

function unwrapDefault<T>(mod: unknown): T {
  if (mod && typeof mod === "object" && "default" in mod) {
    return (mod as { default: T }).default;
  }
  return mod as T;
}

function requireDingTalkDependency<T>(name: string): T {
  try {
    return pluginRequire(name) as T;
  } catch {
    throw new Error(
      `DingTalk dependency "${name}" is missing. Run npm install --omit=dev in extensions/dingtalk.`,
    );
  }
}

export function loadDingTalkAxios(): AxiosClientLike {
  return unwrapDefault<AxiosClientLike>(requireDingTalkDependency("axios"));
}

export function loadDingTalkFormData(): FormDataCtor {
  return unwrapDefault<FormDataCtor>(requireDingTalkDependency("form-data"));
}

export function loadFfmpegInstaller(): FfmpegInstallerLike {
  return unwrapDefault<FfmpegInstallerLike>(requireDingTalkDependency("@ffmpeg-installer/ffmpeg"));
}

export function loadDingTalkStreamModule(): DingTalkStreamModuleLike {
  return requireDingTalkDependency<DingTalkStreamModuleLike>("dingtalk-stream");
}
