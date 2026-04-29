// 引入 Node.js 文件系统常量、文件操作和操作系统模块
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// 引入提供商 ID 规范化工具
import { findNormalizedProviderValue } from "../agents/provider-id.js";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
// 引入全局日志工具和日志级别
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { logWarn } from "../logger.js";
// 引入媒体相关模块
import { resolveChannelInboundAttachmentRoots } from "../media/channel-inbound-roots.js";
import { mergeInboundPathRoots } from "../media/inbound-path-policy.js";
import { getDefaultMediaLocalRoots } from "../media/local-roots.js";
import { runExec } from "../process/exec.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../shared/string-coerce.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import { MediaAttachmentCache, selectAttachments } from "./attachments.js";
import { isMediaUnderstandingSkipError } from "./errors.js";
import { fileExists } from "./fs.js";
import { extractGeminiResponse } from "./output-extract.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";
import { providerSupportsCapability } from "./provider-supports.js";
import { resolveModelEntries, resolveScopeDecision } from "./resolve.js";
import {
  buildModelDecision,
  formatDecisionSummary,
  runCliEntry,
  runProviderEntry,
} from "./runner.entries.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
// 导出附件相关功能
export { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
export type { ActiveMediaModel } from "./active-model.types.js";

// 提供商注册表类型
type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
// 提供商认证可用性检查类型
type HasAvailableAuthForProvider =
  typeof import("../agents/model-auth.js").hasAvailableAuthForProvider;
// 模型目录 API 类型
type ModelCatalogApi = typeof import("../agents/model-catalog.js");
// 模型目录类型
type ModelCatalog = Awaited<ReturnType<ModelCatalogApi["loadModelCatalog"]>>;

// 运行能力结果类型
export type RunCapabilityResult = {
  outputs: MediaUnderstandingOutput[];    // 输出数组
  decision: MediaUnderstandingDecision;  // 决策结果
};

// 缓存的模型目录 API 实例
let cachedHasAvailableAuthForProvider: HasAvailableAuthForProvider | null = null;
let cachedModelCatalogApi: ModelCatalogApi | null = null;

/**
 * 加载模型目录 API（延迟加载）
 * @returns 模型目录 API
 */
async function loadModelCatalogApi(): Promise<ModelCatalogApi> {
  cachedModelCatalogApi ??= await import("../agents/model-catalog.js");
  return cachedModelCatalogApi;
}

/**
 * 解析字面上的提供商 API 密钥
 * @param cfg - OpenClaw 配置
 * @param providerId - 提供商 ID
 * @returns API 密钥或 null
 */
function resolveLiteralProviderApiKey(
  cfg: OpenClawConfig | undefined,
  providerId: string,
): string | null {
  const value = cfg?.models?.providers?.[providerId]?.apiKey;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 检查提供商是否有可用认证
 * @param params - 检查参数
 * @returns 是否有可用认证
 */
async function hasProviderAuthAvailable(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<boolean> {
  // 先检查字面 API 密钥
  if (resolveLiteralProviderApiKey(params.cfg, params.provider)) {
    return true;
  }
  // 动态加载认证检查函数
  cachedHasAvailableAuthForProvider ??= (await import("../agents/model-auth.js"))
    .hasAvailableAuthForProvider;
  return await cachedHasAvailableAuthForProvider(params);
}

/**
 * 解析配置的关键提供商顺序
 * @param params - 解析参数
 * @returns 提供商 ID 数组
 */
function resolveConfiguredKeyProviderOrder(params: {
  cfg: OpenClawConfig;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  fallbackProviders: readonly string[];
}): string[] {
  // 获取配置中定义的所有提供商
  const configuredProviders = Object.keys(params.cfg.models?.providers ?? {})
    .map((providerId) => normalizeMediaProviderId(providerId))  // 规范化提供商 ID
    .filter(Boolean)  // 过滤空值
    .filter((providerId, index, values) => values.indexOf(providerId) === index)  // 去重
    .filter((providerId) =>
      providerSupportsCapability(params.providerRegistry.get(providerId), params.capability),  // 检查能力支持
    );

  // 合并配置的提供商和回退提供商
  return [...new Set([...configuredProviders, ...params.fallbackProviders])];
}

/**
 * 解析配置的图像模型 ID
 * @param params - 解析参数
 * @returns 模型 ID 或 undefined
 */
function resolveConfiguredImageModelId(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): string | undefined {
  const configured = resolveConfiguredImageModel(params);
  const id = configured?.id?.trim();
  return id || undefined;
}

/**
 * 解析配置的图像模型
 * @param params - 解析参数
 * @returns 模型配置或 undefined
 */
function resolveConfiguredImageModel(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): { id?: string; input?: string[] } | undefined {
  const providerCfg = findNormalizedProviderValue(
    params.cfg.models?.providers,
    params.providerId,
  ) as
    | {
        models?: Array<{
          id?: string;
          input?: string[];
        }>;
      }
    | undefined;
  // 查找支持图像输入的模型
  return providerCfg?.models?.find((entry) => {
    const id = entry?.id?.trim();
    return Boolean(id) && entry?.input?.includes("image");
  });
}

/**
 * 从目录解析图像模型 ID
 * @param params - 解析参数
 * @returns 模型 ID 或 undefined
 */
function resolveCatalogImageModelId(params: {
  providerId: string;
  catalog: ModelCatalog;
  modelSupportsVision: ModelCatalogApi["modelSupportsVision"];
}): string | undefined {
  // 查找匹配的提供商和视觉支持模型
  const matches = params.catalog.filter(
    (entry) =>
      normalizeMediaProviderId(entry.provider) === params.providerId &&
      params.modelSupportsVision(entry),
  );
  if (matches.length === 0) {
    return undefined;
  }
  // 优先选择 "auto" 模型
  const autoEntry = matches.find((entry) => normalizeLowercaseStringOrEmpty(entry.id) === "auto");
  return normalizeOptionalString((autoEntry ?? matches[0])?.id);
}

/**
 * 从注册表解析默认媒体模型
 * @param params - 解析参数
 * @returns 默认模型 ID 或 undefined
 */
function resolveDefaultMediaModelFromRegistry(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
  providerRegistry: ProviderRegistry;
}): string | undefined {
  const provider = params.providerRegistry.get(normalizeMediaProviderId(params.providerId));
  return normalizeOptionalString(provider?.defaultModels?.[params.capability]);
}

/**
 * 从注册表解析自动媒体密钥提供商
 * @param params - 解析参数
 * @returns 提供商 ID 数组（按优先级排序）
 */
function resolveAutoMediaKeyProvidersFromRegistry(params: {
  capability: MediaUnderstandingCapability;
  providerRegistry: ProviderRegistry;
}): string[] {
  type AutoProviderEntry = {
    provider: MediaUnderstandingProvider;
    priority: number;
  };
  // 筛选支持该能力的提供商
  return [...params.providerRegistry.values()]
    .filter(
      (provider) =>
        provider.capabilities?.includes(params.capability) ??
        providerSupportsCapability(provider, params.capability),
    )
    .map((provider): AutoProviderEntry | null => {
      const priority = provider.autoPriority?.[params.capability];
      return typeof priority === "number" && Number.isFinite(priority)
        ? { provider, priority }
        : null;
    })
    .filter((entry): entry is AutoProviderEntry => entry !== null)
    .toSorted((left, right) => {
      // 按优先级排序，同优先级按 ID 排序
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.provider.id.localeCompare(right.provider.id);
    })
    .map((entry) => normalizeMediaProviderId(entry.provider.id))
    .filter(Boolean);
}

/**
 * 获取显式图像模型视觉状态
 * @param params - 检查参数
 * @returns 支持状态：supported/unsupported/unknown
 */
async function explicitImageModelVisionStatus(params: {
  cfg: OpenClawConfig;
  providerId: string;
  model: string;
}): Promise<"supported" | "unsupported" | "unknown"> {
  const configured = resolveConfiguredImageModel(params);
  // 显式配置且支持图像输入
  if (configured?.id?.trim() === params.model && configured.input?.includes("image")) {
    return "supported";
  }
  // 从模型目录检查
  const { findModelInCatalog, loadModelCatalog, modelSupportsVision } = await loadModelCatalogApi();
  const catalog = await loadModelCatalog({ config: params.cfg });
  const entry = findModelInCatalog(catalog, params.providerId, params.model);
  if (!entry) {
    return "unknown";
  }
  return modelSupportsVision(entry) ? "supported" : "unsupported";
}

/**
 * 解析自动图像模型 ID
 * @param params - 解析参数
 * @returns 图像模型 ID 或 undefined
 */
async function resolveAutoImageModelId(params: {
  cfg: OpenClawConfig;
  providerId: string;
  providerRegistry: ProviderRegistry;
  explicitModel?: string;
}): Promise<string | undefined> {
  const explicit = normalizeOptionalString(params.explicitModel);
  if (explicit) {
    // 检查显式模型是否支持视觉
    const explicitStatus = await explicitImageModelVisionStatus({
      cfg: params.cfg,
      providerId: params.providerId,
      model: explicit,
    });
    if (explicitStatus !== "unsupported") {
      return explicit;
    }
  }
  // 检查配置的模型
  const configuredModel = resolveConfiguredImageModelId(params);
  if (configuredModel) {
    return configuredModel;
  }
  // 检查注册表默认模型
  const defaultModel = resolveDefaultMediaModelFromRegistry({
    providerId: params.providerId,
    capability: "image",
    providerRegistry: params.providerRegistry,
  });
  if (defaultModel) {
    return defaultModel;
  }
  // 检查捆绑默认模型
  const { resolveDefaultMediaModel } = await import("./defaults.js");
  const bundledDefaultModel = resolveDefaultMediaModel({
    cfg: params.cfg,
    providerId: params.providerId,
    capability: "image",
  });
  if (bundledDefaultModel) {
    return bundledDefaultModel;
  }
  // 从模型目录解析
  const { loadModelCatalog, modelSupportsVision } = await loadModelCatalogApi();
  const catalog = await loadModelCatalog({ config: params.cfg });
  return resolveCatalogImageModelId({
    providerId: params.providerId,
    catalog,
    modelSupportsVision,
  });
}

/**
 * 构建提供商注册表
 * @param overrides - 可选的提供商覆盖
 * @param cfg - OpenClaw 配置
 * @returns 提供商注册表
 */
export function buildProviderRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
  cfg?: OpenClawConfig,
): ProviderRegistry {
  return buildMediaUnderstandingRegistry(overrides, cfg);
}

/**
 * 解析媒体附件本地根目录
 * @param params - 解析参数
 * @returns 本地根目录数组
 */
export function resolveMediaAttachmentLocalRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] {
  // ctx.MediaWorkspaceDir 由 chat.send 的 prestageNonImageOffloads 设置
  // 当附件被暂存到沙箱工作区时，路径保持沙箱相对
  // 工作区目录被单独传递，以便主机端媒体理解仍可通过此根列表解析
  const workspaceDir = params.ctx.MediaWorkspaceDir;
  return mergeInboundPathRoots(
    getDefaultMediaLocalRoots(),
    workspaceDir ? [path.resolve(workspaceDir)] : undefined,
    resolveChannelInboundAttachmentRoots(params),
  );
}

// 二进制文件缓存和 Gemini 探测缓存
const binaryCache = new Map<string, Promise<string | null>>();
const geminiProbeCache = new Map<string, Promise<boolean>>();

/**
 * 清除媒体理解二进制缓存（仅用于测试）
 */
export function clearMediaUnderstandingBinaryCacheForTests(): void {
  binaryCache.clear();
  geminiProbeCache.clear();
}

/**
 * 展开 HOME 目录简写
 * @param value - 路径值
 * @returns 展开后的路径
 */
function expandHomeDir(value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }
  const home = os.homedir();
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

/**
 * 检查是否包含路径分隔符
 * @param value - 待检查的值
 * @returns 是否包含分隔符
 */
function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/**
 * 生成候选二进制文件名（Windows 兼容）
 * @param name - 二进制名称
 * @returns 候选文件名数组
 */
function candidateBinaryNames(name: string): string[] {
  if (process.platform !== "win32") {
    return [name]; // 非 Windows 直接返回
  }
  const ext = path.extname(name);
  if (ext) {
    return [name]; // 已有扩展名
  }
  // 处理 PATHEXT 环境变量
  const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
  const unique = Array.from(new Set(pathext));
  return [name, ...unique.map((item) => `${name}${item}`)];
}

/**
 * 检查文件是否可执行
 * @param filePath - 文件路径
 * @returns 是否可执行
 */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true; // Windows 不做权限检查
    }
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 查找二进制文件
 * @param name - 二进制名称
 * @returns 二进制路径或 null
 */
async function findBinary(name: string): Promise<string | null> {
  const cached = binaryCache.get(name);
  if (cached) {
    return cached;
  }
  const resolved = (async () => {
    const direct = expandHomeDir(name.trim());
    // 绝对路径或包含分隔符的路径
    if (direct && hasPathSeparator(direct)) {
      for (const candidate of candidateBinaryNames(direct)) {
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }

    const searchName = name.trim();
    if (!searchName) {
      return null;
    }
    // 搜索 PATH 环境变量
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
    const candidates = candidateBinaryNames(searchName);
    for (const entryRaw of pathEntries) {
      const entry = expandHomeDir(entryRaw.trim().replace(/^"(.*)"$/, "$1"));
      if (!entry) {
        continue;
      }
      for (const candidate of candidates) {
        const fullPath = path.join(entry, candidate);
        if (await isExecutable(fullPath)) {
          return fullPath;
        }
      }
    }

    return null;
  })();
  binaryCache.set(name, resolved);
  return resolved;
}

/**
 * 检查二进制是否存在
 * @param name - 二进制名称
 * @returns 是否存在
 */
async function hasBinary(name: string): Promise<boolean> {
  return Boolean(await findBinary(name));
}

/**
 * 探测 Gemini CLI 是否可用
 * @returns 是否可用
 */
async function probeGeminiCli(): Promise<boolean> {
  const cached = geminiProbeCache.get("gemini");
  if (cached) {
    return cached;
  }
  const resolved = (async () => {
    if (!(await hasBinary("gemini"))) {
      return false;
    }
    try {
      // 执行 gemini ok 命令测试
      const { stdout } = await runExec("gemini", ["--output-format", "json", "ok"], {
        timeoutMs: 8000,
      });
      return Boolean(
        extractGeminiResponse(stdout) ?? normalizeLowercaseStringOrEmpty(stdout).includes("ok"),
      );
    } catch {
      return false;
    }
  })();
  geminiProbeCache.set("gemini", resolved);
  return resolved;
}

/**
 * 解析本地 Whisper CPP 入口配置
 * @returns CLI 入口配置或 null
 */
async function resolveLocalWhisperCppEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("whisper-cli"))) {
    return null;
  }
  const envModel = process.env.WHISPER_CPP_MODEL?.trim();
  const defaultModel = "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin";
  const modelPath = envModel && (await fileExists(envModel)) ? envModel : defaultModel;
  if (!(await fileExists(modelPath))) {
    return null;
  }
  return {
    type: "cli",
    command: "whisper-cli",
    args: ["-m", modelPath, "-otxt", "-of", "{{OutputBase}}", "-np", "-nt", "{{MediaPath}}"],
  };
}

/**
 * 解析本地 Whisper 入口配置
 * @returns CLI 入口配置或 null
 */
async function resolveLocalWhisperEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("whisper"))) {
    return null;
  }
  return {
    type: "cli",
    command: "whisper",
    args: [
      "--model",
      "turbo",
      "--output_format",
      "txt",
      "--output_dir",
      "{{OutputDir}}",
      "--verbose",
      "False",
      "{{MediaPath}}",
    ],
  };
}

/**
 * 解析本地 Sherpa Onnx 入口配置
 * @returns CLI 入口配置或 null
 */
async function resolveSherpaOnnxEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("sherpa-onnx-offline"))) {
    return null;
  }
  const modelDir = process.env.SHERPA_ONNX_MODEL_DIR?.trim();
  if (!modelDir) {
    return null;
  }
  // 检查必需的模型文件
  const tokens = path.join(modelDir, "tokens.txt");
  const encoder = path.join(modelDir, "encoder.onnx");
  const decoder = path.join(modelDir, "decoder.onnx");
  const joiner = path.join(modelDir, "joiner.onnx");
  if (!(await fileExists(tokens))) {
    return null;
  }
  if (!(await fileExists(encoder))) {
    return null;
  }
  if (!(await fileExists(decoder))) {
    return null;
  }
  if (!(await fileExists(joiner))) {
    return null;
  }
  return {
    type: "cli",
    command: "sherpa-onnx-offline",
    args: [
      `--tokens=${tokens}`,
      `--encoder=${encoder}`,
      `--decoder=${decoder}`,
      `--joiner=${joiner}`,
      "{{MediaPath}}",
    ],
  };
}

/**
 * 解析本地音频入口配置
 * @returns CLI 入口配置或 null
 */
async function resolveLocalAudioEntry(): Promise<MediaUnderstandingModelConfig | null> {
  // 按优先级尝试：Sherpa > Whisper CPP > Whisper
  const sherpa = await resolveSherpaOnnxEntry();
  if (sherpa) {
    return sherpa;
  }
  const whisperCpp = await resolveLocalWhisperCppEntry();
  if (whisperCpp) {
    return whisperCpp;
  }
  return await resolveLocalWhisperEntry();
}

/**
 * 解析 Gemini CLI 入口配置
 * @param _capability - 能力类型
 * @returns CLI 入口配置或 null
 */
async function resolveGeminiCliEntry(
  _capability: MediaUnderstandingCapability,
): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await probeGeminiCli())) {
    return null;
  }
  return {
    type: "cli",
    command: "gemini",
    args: [
      "--output-format",
      "json",
      "--allowed-tools",
      "read_many_files",
      "--include-directories",
      "{{MediaDir}}",
      "{{Prompt}}",
      "Use read_many_files to read {{MediaPath}} and respond with only the text output.",
    ],
  };
}

/**
 * 解析关键入口配置
 * @param params - 解析参数
 * @returns 模型配置或 null
 */
async function resolveKeyEntry(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig | null> {
  const { cfg, agentDir, providerRegistry, capability } = params;
  // 检查提供商的函数
  const checkProvider = async (
    providerId: string,
    model?: string,
  ): Promise<MediaUnderstandingModelConfig | null> => {
    const provider = getMediaUnderstandingProvider(providerId, providerRegistry);
    if (!provider) {
      return null;
    }
    // 检查提供商是否支持该能力
    if (capability === "audio" && !provider.transcribeAudio) {
      return null;
    }
    if (capability === "image" && !provider.describeImage) {
      return null;
    }
    if (capability === "video" && !provider.describeVideo) {
      return null;
    }
    // 检查认证可用性
    if (
      !(await hasProviderAuthAvailable({
        provider: providerId,
        cfg,
        agentDir,
      }))
    ) {
      return null;
    }
    // 解析模型
    const resolvedModel =
      capability === "image"
        ? await resolveAutoImageModelId({
            cfg,
            providerId,
            providerRegistry,
            explicitModel: model,
          })
        : model;
    if (capability === "image" && !resolvedModel) {
      return null;
    }
    return { type: "provider" as const, provider: providerId, model: resolvedModel };
  };

  // 先检查活动提供商
  const activeProvider = params.activeModel?.provider?.trim();
  if (activeProvider) {
    const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
    if (activeEntry) {
      return activeEntry;
    }
  }
  // 遍历配置的提供商
  for (const providerId of resolveConfiguredKeyProviderOrder({
    cfg,
    providerRegistry,
    capability,
    fallbackProviders: resolveAutoMediaKeyProvidersFromRegistry({
      capability,
      providerRegistry,
    }),
  })) {
    const entry = await checkProvider(providerId, undefined);
    if (entry) {
      return entry;
    }
  }
  return null;
}

/**
 * 从代理默认值解析图像模型
 * @param cfg - OpenClaw 配置
 * @returns 模型配置数组
 */
function resolveImageModelFromAgentDefaults(cfg: OpenClawConfig): MediaUnderstandingModelConfig[] {
  const refs: string[] = [];
  // 获取主模型
  const primary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel);
  if (primary?.trim()) {
    refs.push(primary.trim());
  }
  // 获取回退模型
  for (const fb of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) {
    if (fb?.trim()) {
      refs.push(fb.trim());
    }
  }
  if (refs.length === 0) {
    return [];
  }
  // 解析为模型配置
  const entries: MediaUnderstandingModelConfig[] = [];
  for (const ref of refs) {
    const slashIdx = ref.indexOf("/");
    if (slashIdx <= 0 || slashIdx >= ref.length - 1) {
      continue;
    }
    entries.push({
      type: "provider",
      provider: ref.slice(0, slashIdx),
      model: ref.slice(slashIdx + 1),
    });
  }
  return entries;
}

/**
 * 检查是否有显式图像理解配置
 * @param params - 检查参数
 * @returns 是否有显式配置
 */
function hasExplicitImageUnderstandingConfig(params: {
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): boolean {
  return (
    (params.config?.models?.length ?? 0) > 0 ||
    resolveImageModelFromAgentDefaults(params.cfg).length > 0
  );
}

/**
 * 解析自动条目
 * @param params - 解析参数
 * @returns 模型配置数组
 */
async function resolveAutoEntries(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig[]> {
  // 图像：使用代理默认值
  if (params.capability === "image") {
    const imageModelEntries = resolveImageModelFromAgentDefaults(params.cfg);
    if (imageModelEntries.length > 0) {
      return imageModelEntries;
    }
  }
  // 活动模型
  const activeEntry = await resolveActiveModelEntry(params);
  if (activeEntry) {
    return [activeEntry];
  }
  // 音频：尝试本地条目
  if (params.capability === "audio") {
    const keyEntry = await resolveKeyEntry(params);
    if (keyEntry) {
      return [keyEntry];
    }
    const localAudio = await resolveLocalAudioEntry();
    if (localAudio) {
      return [localAudio];
    }
  }
  // Gemini CLI
  const gemini = await resolveGeminiCliEntry(params.capability);
  if (gemini) {
    return [gemini];
  }
  // 密钥提供商
  const keys = await resolveKeyEntry(params);
  if (keys) {
    return [keys];
  }
  return [];
}

/**
 * 解析自动图像模型
 * @param params - 解析参数
 * @returns 活动媒体模型或 null
 */
export async function resolveAutoImageModel(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel?: ActiveMediaModel;
}): Promise<ActiveMediaModel | null> {
  const providerRegistry = buildProviderRegistry(undefined, params.cfg);
  // 转换为活动模型的函数
  const toActive = (entry: MediaUnderstandingModelConfig | null): ActiveMediaModel | null => {
    if (!entry || entry.type === "cli") {
      return null;
    }
    const provider = entry.provider;
    const model = entry.model?.trim();
    if (!provider || !model) {
      return null;
    }
    return { provider, model };
  };
  // 检查配置的图像模型
  const configuredImageModel = resolveImageModelFromAgentDefaults(params.cfg)
    .map((entry) => toActive(entry))
    .find((entry): entry is ActiveMediaModel => entry !== null);
  if (configuredImageModel) {
    return configuredImageModel;
  }
  // 检查活动模型
  const activeEntry = await resolveActiveModelEntry({
    cfg: params.cfg,
    agentDir: params.agentDir,
    providerRegistry,
    capability: "image",
    activeModel: params.activeModel,
  });
  const resolvedActive = toActive(activeEntry);
  if (resolvedActive) {
    return resolvedActive;
  }
  // 检查密钥条目
  const keyEntry = await resolveKeyEntry({
    cfg: params.cfg,
    agentDir: params.agentDir,
    providerRegistry,
    capability: "image",
    activeModel: params.activeModel,
  });
  return toActive(keyEntry);
}

/**
 * 解析活动模型条目
 * @param params - 解析参数
 * @returns 模型配置或 null
 */
async function resolveActiveModelEntry(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig | null> {
  const activeProviderRaw = params.activeModel?.provider?.trim();
  if (!activeProviderRaw) {
    return null;
  }
  const providerId = normalizeMediaProviderId(activeProviderRaw);
  if (!providerId) {
    return null;
  }
  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    return null;
  }
  // 检查能力支持
  if (params.capability === "audio" && !provider.transcribeAudio) {
    return null;
  }
  if (params.capability === "image" && !provider.describeImage) {
    return null;
  }
  if (params.capability === "video" && !provider.describeVideo) {
    return null;
  }
  // 检查认证
  const hasAuth = await hasProviderAuthAvailable({
    provider: providerId,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
  if (!hasAuth) {
    return null;
  }
  // 解析模型
  const model =
    params.capability === "image"
      ? await resolveAutoImageModelId({
          cfg: params.cfg,
          providerId,
          providerRegistry: params.providerRegistry,
          explicitModel: params.activeModel?.model,
        })
      : params.activeModel?.model;
  if (params.capability === "image" && !model) {
    return null;
  }
  return {
    type: "provider",
    provider: providerId,
    model,
  };
}

/**
 * 运行附件条目
 * @param params - 运行参数
 * @returns 输出和尝试数组
 */
async function runAttachmentEntries(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachmentIndex: number;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  cache: MediaAttachmentCache;
  entries: MediaUnderstandingModelConfig[];
  config?: MediaUnderstandingConfig;
}): Promise<{
  output: MediaUnderstandingOutput | null;
  attempts: MediaUnderstandingModelDecision[];
}> {
  const { entries, capability } = params;
  const attempts: MediaUnderstandingModelDecision[] = [];
  // 遍历条目执行
  for (const entry of entries) {
    const entryType = entry.type ?? (entry.command ? "cli" : "provider");
    try {
      const result =
        entryType === "cli"
          ? await runCliEntry({  // CLI 类型入口
              capability,
              entry,
              cfg: params.cfg,
              ctx: params.ctx,
              attachmentIndex: params.attachmentIndex,
              cache: params.cache,
              config: params.config,
            })
          : await runProviderEntry({  // 提供商类型入口
              capability,
              entry,
              cfg: params.cfg,
              ctx: params.ctx,
              attachmentIndex: params.attachmentIndex,
              cache: params.cache,
              agentDir: params.agentDir,
              providerRegistry: params.providerRegistry,
              config: params.config,
            });
      if (result) {
        // 成功，构建决策
        const decision = buildModelDecision({ entry, entryType, outcome: "success" });
        if (result.provider) {
          decision.provider = result.provider;
        }
        if (result.model) {
          decision.model = result.model;
        }
        attempts.push(decision);
        return { output: result, attempts };
      }
      // 空输出
      attempts.push(
        buildModelDecision({ entry, entryType, outcome: "skipped", reason: "empty output" }),
      );
    } catch (err) {
      if (isMediaUnderstandingSkipError(err)) {
        // 跳过错误
        attempts.push(
          buildModelDecision({
            entry,
            entryType,
            outcome: "skipped",
            reason: `${err.reason}: ${err.message}`,
          }),
        );
        if (shouldLogVerbose()) {
          logVerbose(`Skipping ${capability} model due to ${err.reason}: ${err.message}`);
        }
        continue;
      }
      // 失败
      attempts.push(
        buildModelDecision({
          entry,
          entryType,
          outcome: "failed",
          reason: String(err),
        }),
      );
      if (shouldLogVerbose()) {
        logVerbose(`${capability} understanding failed: ${String(err)}`);
      }
    }
  }

  return { output: null, attempts };
}

/**
 * 检查是否有失败的媒体尝试
 * @param attachments - 附件决策数组
 * @returns 是否有失败
 */
function hasFailedMediaAttempt(attachments: MediaUnderstandingDecision["attachments"]): boolean {
  return attachments.some((attachment) =>
    attachment.attempts.some((attempt) => attempt.outcome === "failed"),
  );
}

/**
 * 运行能力
 * @param params - 运行参数
 * @returns 能力和决策结果
 */
export async function runCapability(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  ctx: MsgContext;
  attachments: MediaAttachmentCache;
  media: MediaAttachment[];
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  config?: MediaUnderstandingConfig;
  activeModel?: ActiveMediaModel;
}): Promise<RunCapabilityResult> {
  const { capability, cfg, ctx } = params;
  const config = params.config ?? cfg.tools?.media?.[capability];
  // 能力被禁用
  if (config?.enabled === false) {
    return {
      outputs: [],
      decision: { capability, outcome: "disabled", attachments: [] },
    };
  }

  // 选择附件
  const attachmentPolicy = config?.attachments;
  const selected = selectAttachments({
    capability,
    attachments: params.media,
    policy: attachmentPolicy,
  });
  if (selected.length === 0) {
    return {
      outputs: [],
      decision: { capability, outcome: "no-attachment", attachments: [] },
    };
  }

  // 范围决策
  const scopeDecision = resolveScopeDecision({ scope: config?.scope, ctx });
  if (scopeDecision === "deny") {
    if (shouldLogVerbose()) {
      logVerbose(`${capability} understanding disabled by scope policy.`);
    }
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "scope-deny",
        attachments: selected.map((item) => ({ attachmentIndex: item.index, attempts: [] })),
      },
    };
  }

  // 当主模型原生支持视觉时跳过图像理解
  // 图像将直接注入模型上下文
  const activeProvider = params.activeModel?.provider?.trim();
  if (
    capability === "image" &&
    activeProvider &&
    !hasExplicitImageUnderstandingConfig({ cfg, config })
  ) {
    const { findModelInCatalog, loadModelCatalog, modelSupportsVision } =
      await loadModelCatalogApi();
    const catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, activeProvider, params.activeModel?.model ?? "");
    if (modelSupportsVision(entry)) {
      if (shouldLogVerbose()) {
        logVerbose("Skipping image understanding: primary model supports vision natively");
      }
      const model = params.activeModel?.model?.trim();
      const reason = "primary model supports vision natively";
      return {
        outputs: [],
        decision: {
          capability,
          outcome: "skipped",
          attachments: selected.map((item) => {
            const attempt = {
              type: "provider" as const,
              provider: activeProvider,
              model: model || undefined,
              outcome: "skipped" as const,
              reason,
            };
            return {
              attachmentIndex: item.index,
              attempts: [attempt],
              chosen: attempt,
            };
          }),
        },
      };
    }
  }

  // 解析模型条目
  const entries = resolveModelEntries({
    cfg,
    capability,
    config,
    providerRegistry: params.providerRegistry,
  });
  let resolvedEntries = entries;
  if (resolvedEntries.length === 0) {
    resolvedEntries = await resolveAutoEntries({
      cfg,
      agentDir: params.agentDir,
      providerRegistry: params.providerRegistry,
      capability,
      activeModel: params.activeModel,
    });
  }
  if (resolvedEntries.length === 0) {
    return {
      outputs: [],
      decision: {
        capability,
        outcome: "skipped",
        attachments: selected.map((item) => ({ attachmentIndex: item.index, attempts: [] })),
      },
    };
  }

  // 运行每个附件
  const outputs: MediaUnderstandingOutput[] = [];
  const attachmentDecisions: MediaUnderstandingDecision["attachments"] = [];
  for (const attachment of selected) {
    const { output, attempts } = await runAttachmentEntries({
      capability,
      cfg,
      ctx,
      attachmentIndex: attachment.index,
      agentDir: params.agentDir,
      providerRegistry: params.providerRegistry,
      cache: params.attachments,
      entries: resolvedEntries,
      config,
    });
    if (output) {
      outputs.push(output);
    }
    attachmentDecisions.push({
      attachmentIndex: attachment.index,
      attempts,
      chosen: attempts.find((attempt) => attempt.outcome === "success"),
    });
  }
  // 构建最终决策
  const decision: MediaUnderstandingDecision = {
    capability,
    outcome:
      outputs.length > 0
        ? "success"
        : hasFailedMediaAttempt(attachmentDecisions)
          ? "failed"
          : "skipped",
    attachments: attachmentDecisions,
  };
  // 记录日志
  if (decision.outcome === "failed") {
    logWarn(`media-understanding: ${formatDecisionSummary(decision)}`);
  } else if (shouldLogVerbose()) {
    logVerbose(`Media understanding ${formatDecisionSummary(decision)}`);
  }
  return {
    outputs,
    decision,
  };
}
