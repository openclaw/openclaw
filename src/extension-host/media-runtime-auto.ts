import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  getExtensionHostMediaUnderstandingProvider,
  normalizeExtensionHostMediaProviderId,
  type ExtensionHostMediaUnderstandingProviderRegistry,
} from "../extension-host/media-runtime-registry.js";
import {
  AUTO_AUDIO_KEY_PROVIDERS,
  AUTO_IMAGE_KEY_PROVIDERS,
  AUTO_VIDEO_KEY_PROVIDERS,
  DEFAULT_IMAGE_MODELS,
} from "../media-understanding/defaults.js";
import { fileExists } from "../media-understanding/fs.js";
import { extractGeminiResponse } from "../media-understanding/output-extract.js";
import type { MediaUnderstandingCapability } from "../media-understanding/types.js";
import { runExec } from "../process/exec.js";

export type ActiveMediaModel = {
  provider: string;
  model?: string;
};

type ProviderRegistry = ExtensionHostMediaUnderstandingProviderRegistry;

const binaryCache = new Map<string, Promise<string | null>>();
const geminiProbeCache = new Map<string, Promise<boolean>>();

export function clearMediaUnderstandingBinaryCacheForTests(): void {
  binaryCache.clear();
  geminiProbeCache.clear();
}

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

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function candidateBinaryNames(name: string): string[] {
  if (process.platform !== "win32") {
    return [name];
  }
  const ext = path.extname(name);
  if (ext) {
    return [name];
  }
  const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
  const unique = Array.from(new Set(pathext));
  return [name, ...unique.map((item) => `${name}${item}`)];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBinary(name: string): Promise<string | null> {
  const cached = binaryCache.get(name);
  if (cached) {
    return cached;
  }
  const resolved = (async () => {
    const direct = expandHomeDir(name.trim());
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

async function hasBinary(name: string): Promise<boolean> {
  return Boolean(await findBinary(name));
}

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
      const { stdout } = await runExec("gemini", ["--output-format", "json", "ok"], {
        timeoutMs: 8000,
      });
      return Boolean(extractGeminiResponse(stdout) ?? stdout.toLowerCase().includes("ok"));
    } catch {
      return false;
    }
  })();
  geminiProbeCache.set("gemini", resolved);
  return resolved;
}

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

async function resolveSherpaOnnxEntry(): Promise<MediaUnderstandingModelConfig | null> {
  if (!(await hasBinary("sherpa-onnx-offline"))) {
    return null;
  }
  const modelDir = process.env.SHERPA_ONNX_MODEL_DIR?.trim();
  if (!modelDir) {
    return null;
  }
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

async function resolveLocalAudioEntry(): Promise<MediaUnderstandingModelConfig | null> {
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
  const providerId = normalizeExtensionHostMediaProviderId(activeProviderRaw);
  if (!providerId) {
    return null;
  }
  const provider = getExtensionHostMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider) {
    return null;
  }
  if (params.capability === "audio" && !provider.transcribeAudio) {
    return null;
  }
  if (params.capability === "image" && !provider.describeImage) {
    return null;
  }
  if (params.capability === "video" && !provider.describeVideo) {
    return null;
  }
  try {
    await resolveApiKeyForProvider({
      provider: providerId,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  } catch {
    return null;
  }
  return {
    type: "provider",
    provider: providerId,
    model: params.activeModel?.model,
  };
}

async function resolveKeyEntry(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig | null> {
  const { cfg, agentDir, providerRegistry, capability } = params;
  const checkProvider = async (
    providerId: string,
    model?: string,
  ): Promise<MediaUnderstandingModelConfig | null> => {
    const provider = getExtensionHostMediaUnderstandingProvider(providerId, providerRegistry);
    if (!provider) {
      return null;
    }
    if (capability === "audio" && !provider.transcribeAudio) {
      return null;
    }
    if (capability === "image" && !provider.describeImage) {
      return null;
    }
    if (capability === "video" && !provider.describeVideo) {
      return null;
    }
    try {
      await resolveApiKeyForProvider({ provider: providerId, cfg, agentDir });
      return { type: "provider", provider: providerId, model };
    } catch {
      return null;
    }
  };

  if (capability === "image") {
    const activeProvider = params.activeModel?.provider?.trim();
    if (activeProvider) {
      const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
      if (activeEntry) {
        return activeEntry;
      }
    }
    for (const providerId of AUTO_IMAGE_KEY_PROVIDERS) {
      const model = DEFAULT_IMAGE_MODELS[providerId];
      const entry = await checkProvider(providerId, model);
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  if (capability === "video") {
    const activeProvider = params.activeModel?.provider?.trim();
    if (activeProvider) {
      const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
      if (activeEntry) {
        return activeEntry;
      }
    }
    for (const providerId of AUTO_VIDEO_KEY_PROVIDERS) {
      const entry = await checkProvider(providerId, undefined);
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  const activeProvider = params.activeModel?.provider?.trim();
  if (activeProvider) {
    const activeEntry = await checkProvider(activeProvider, params.activeModel?.model);
    if (activeEntry) {
      return activeEntry;
    }
  }
  for (const providerId of AUTO_AUDIO_KEY_PROVIDERS) {
    const entry = await checkProvider(providerId, undefined);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function resolveImageModelFromAgentDefaults(cfg: OpenClawConfig): MediaUnderstandingModelConfig[] {
  const refs: string[] = [];
  const primary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel);
  if (primary?.trim()) {
    refs.push(primary.trim());
  }
  for (const fb of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) {
    if (fb?.trim()) {
      refs.push(fb.trim());
    }
  }
  if (refs.length === 0) {
    return [];
  }
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

export async function resolveAutoEntries(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  providerRegistry: ProviderRegistry;
  capability: MediaUnderstandingCapability;
  activeModel?: ActiveMediaModel;
}): Promise<MediaUnderstandingModelConfig[]> {
  const activeEntry = await resolveActiveModelEntry(params);
  if (activeEntry) {
    return [activeEntry];
  }
  if (params.capability === "audio") {
    const localAudio = await resolveLocalAudioEntry();
    if (localAudio) {
      return [localAudio];
    }
  }
  if (params.capability === "image") {
    const imageModelEntries = resolveImageModelFromAgentDefaults(params.cfg);
    if (imageModelEntries.length > 0) {
      return imageModelEntries;
    }
  }
  const gemini = await resolveGeminiCliEntry(params.capability);
  if (gemini) {
    return [gemini];
  }
  const keys = await resolveKeyEntry(params);
  if (keys) {
    return [keys];
  }
  return [];
}

export async function resolveAutoImageModel(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel?: ActiveMediaModel;
  providerRegistry: ProviderRegistry;
}): Promise<ActiveMediaModel | null> {
  const toActive = (entry: MediaUnderstandingModelConfig | null): ActiveMediaModel | null => {
    if (!entry || entry.type === "cli") {
      return null;
    }
    const provider = entry.provider;
    if (!provider) {
      return null;
    }
    const model = entry.model ?? DEFAULT_IMAGE_MODELS[provider];
    if (!model) {
      return null;
    }
    return { provider, model };
  };
  const activeEntry = await resolveActiveModelEntry({
    cfg: params.cfg,
    agentDir: params.agentDir,
    providerRegistry: params.providerRegistry,
    capability: "image",
    activeModel: params.activeModel,
  });
  const resolvedActive = toActive(activeEntry);
  if (resolvedActive) {
    return resolvedActive;
  }
  const keyEntry = await resolveKeyEntry({
    cfg: params.cfg,
    agentDir: params.agentDir,
    providerRegistry: params.providerRegistry,
    capability: "image",
    activeModel: params.activeModel,
  });
  return toActive(keyEntry);
}
