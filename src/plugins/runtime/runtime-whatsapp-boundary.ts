import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { resolveWhatsAppHeartbeatRecipients } from "../../channels/plugins/whatsapp-heartbeat.js";
import { loadConfig } from "../../config/config.js";
import {
  getDefaultLocalRoots as getDefaultLocalRootsImpl,
  loadWebMedia as loadWebMediaImpl,
  loadWebMediaRaw as loadWebMediaRawImpl,
  optimizeImageToJpeg as optimizeImageToJpegImpl,
} from "../../media/web-media.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
  shouldPreferNativeJiti,
} from "../sdk-alias.js";

const WHATSAPP_PLUGIN_ID = "whatsapp";

type WhatsAppLightModule = typeof import("../../../extensions/whatsapp/light-runtime-api.js");
type WhatsAppHeavyModule = typeof import("../../../extensions/whatsapp/runtime-api.js");

type WhatsAppPluginRecord = {
  origin: string;
  rootDir?: string;
  source: string;
};

let cachedHeavyModulePath: string | null = null;
let cachedHeavyModule: WhatsAppHeavyModule | null = null;
let cachedLightModulePath: string | null = null;
let cachedLightModule: WhatsAppLightModule | null = null;

const jitiLoaders = new Map<boolean, ReturnType<typeof createJiti>>();

function readConfigSafely() {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

function resolveWhatsAppPluginRecord(): WhatsAppPluginRecord {
  const manifestRegistry = loadPluginManifestRegistry({
    config: readConfigSafely(),
    cache: true,
  });
  const record = manifestRegistry.plugins.find((plugin) => plugin.id === WHATSAPP_PLUGIN_ID);
  if (!record?.source) {
    throw new Error(
      `WhatsApp plugin runtime is unavailable: missing plugin '${WHATSAPP_PLUGIN_ID}'`,
    );
  }
  return {
    origin: record.origin,
    rootDir: record.rootDir,
    source: record.source,
  };
}

function resolveWhatsAppRuntimeModulePath(
  record: WhatsAppPluginRecord,
  entryBaseName: "light-runtime-api" | "runtime-api",
): string {
  const candidates = [
    path.join(path.dirname(record.source), `${entryBaseName}.js`),
    path.join(path.dirname(record.source), `${entryBaseName}.ts`),
    ...(record.rootDir
      ? [
          path.join(record.rootDir, `${entryBaseName}.js`),
          path.join(record.rootDir, `${entryBaseName}.ts`),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `WhatsApp plugin runtime is unavailable: missing ${entryBaseName} for plugin '${WHATSAPP_PLUGIN_ID}'`,
  );
}

function getJiti(modulePath: string) {
  const tryNative = shouldPreferNativeJiti(modulePath);
  const cached = jitiLoaders.get(tryNative);
  if (cached) {
    return cached;
  }
  const pluginSdkAlias = resolvePluginSdkAliasFile({
    srcFile: "root-alias.cjs",
    distFile: "root-alias.cjs",
    modulePath: modulePath,
  });
  const aliasMap = {
    ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
    ...resolvePluginSdkScopedAliasMap({ modulePath }),
  };
  const loader = createJiti(import.meta.url, {
    ...buildPluginLoaderJitiOptions(aliasMap),
    tryNative,
  });
  jitiLoaders.set(tryNative, loader);
  return loader;
}

function loadWithJiti<TModule>(modulePath: string): TModule {
  return getJiti(modulePath)(modulePath) as TModule;
}

function loadCurrentHeavyModuleSync(): WhatsAppHeavyModule {
  const modulePath = resolveWhatsAppRuntimeModulePath(resolveWhatsAppPluginRecord(), "runtime-api");
  return loadWithJiti<WhatsAppHeavyModule>(modulePath);
}

function loadWhatsAppLightModule(): WhatsAppLightModule {
  const modulePath = resolveWhatsAppRuntimeModulePath(
    resolveWhatsAppPluginRecord(),
    "light-runtime-api",
  );
  if (cachedLightModule && cachedLightModulePath === modulePath) {
    return cachedLightModule;
  }
  const loaded = loadWithJiti<WhatsAppLightModule>(modulePath);
  cachedLightModulePath = modulePath;
  cachedLightModule = loaded;
  return loaded;
}

async function loadWhatsAppHeavyModule(): Promise<WhatsAppHeavyModule> {
  const record = resolveWhatsAppPluginRecord();
  const modulePath = resolveWhatsAppRuntimeModulePath(record, "runtime-api");
  if (cachedHeavyModule && cachedHeavyModulePath === modulePath) {
    return cachedHeavyModule;
  }
  const loaded = loadWithJiti<WhatsAppHeavyModule>(modulePath);
  cachedHeavyModulePath = modulePath;
  cachedHeavyModule = loaded;
  return loaded;
}

function getLightExport<K extends keyof WhatsAppLightModule>(
  exportName: K,
): NonNullable<WhatsAppLightModule[K]> {
  const loaded = loadWhatsAppLightModule();
  const value = loaded[exportName];
  if (value == null) {
    throw new Error(`WhatsApp plugin runtime is missing export '${String(exportName)}'`);
  }
  return value as NonNullable<WhatsAppLightModule[K]>;
}

async function getHeavyExport<K extends keyof WhatsAppHeavyModule>(
  exportName: K,
): Promise<NonNullable<WhatsAppHeavyModule[K]>> {
  const loaded = await loadWhatsAppHeavyModule();
  const value = loaded[exportName];
  if (value == null) {
    throw new Error(`WhatsApp plugin runtime is missing export '${String(exportName)}'`);
  }
  return value as NonNullable<WhatsAppHeavyModule[K]>;
}

export function getActiveWebListener(
  ...args: Parameters<WhatsAppLightModule["getActiveWebListener"]>
): ReturnType<WhatsAppLightModule["getActiveWebListener"]> {
  return getLightExport("getActiveWebListener")(...args);
}

export function getWebAuthAgeMs(
  ...args: Parameters<WhatsAppLightModule["getWebAuthAgeMs"]>
): ReturnType<WhatsAppLightModule["getWebAuthAgeMs"]> {
  return getLightExport("getWebAuthAgeMs")(...args);
}

export function logWebSelfId(
  ...args: Parameters<WhatsAppLightModule["logWebSelfId"]>
): ReturnType<WhatsAppLightModule["logWebSelfId"]> {
  return getLightExport("logWebSelfId")(...args);
}

export function loginWeb(
  ...args: Parameters<WhatsAppHeavyModule["loginWeb"]>
): ReturnType<WhatsAppHeavyModule["loginWeb"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.loginWeb(...args));
}

export function logoutWeb(
  ...args: Parameters<WhatsAppLightModule["logoutWeb"]>
): ReturnType<WhatsAppLightModule["logoutWeb"]> {
  return getLightExport("logoutWeb")(...args);
}

export function readWebSelfId(
  ...args: Parameters<WhatsAppLightModule["readWebSelfId"]>
): ReturnType<WhatsAppLightModule["readWebSelfId"]> {
  return getLightExport("readWebSelfId")(...args);
}

export function webAuthExists(
  ...args: Parameters<WhatsAppLightModule["webAuthExists"]>
): ReturnType<WhatsAppLightModule["webAuthExists"]> {
  return getLightExport("webAuthExists")(...args);
}

export function sendMessageWhatsApp(
  ...args: Parameters<WhatsAppHeavyModule["sendMessageWhatsApp"]>
): ReturnType<WhatsAppHeavyModule["sendMessageWhatsApp"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.sendMessageWhatsApp(...args));
}

export function sendPollWhatsApp(
  ...args: Parameters<WhatsAppHeavyModule["sendPollWhatsApp"]>
): ReturnType<WhatsAppHeavyModule["sendPollWhatsApp"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.sendPollWhatsApp(...args));
}

export function sendReactionWhatsApp(
  ...args: Parameters<WhatsAppHeavyModule["sendReactionWhatsApp"]>
): ReturnType<WhatsAppHeavyModule["sendReactionWhatsApp"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.sendReactionWhatsApp(...args));
}

export function createRuntimeWhatsAppLoginTool(
  ...args: Parameters<WhatsAppLightModule["createWhatsAppLoginTool"]>
): ReturnType<WhatsAppLightModule["createWhatsAppLoginTool"]> {
  return getLightExport("createWhatsAppLoginTool")(...args);
}

export function createWaSocket(
  ...args: Parameters<WhatsAppHeavyModule["createWaSocket"]>
): ReturnType<WhatsAppHeavyModule["createWaSocket"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.createWaSocket(...args));
}

export function formatError(
  ...args: Parameters<WhatsAppLightModule["formatError"]>
): ReturnType<WhatsAppLightModule["formatError"]> {
  return getLightExport("formatError")(...args);
}

export function getStatusCode(
  ...args: Parameters<WhatsAppLightModule["getStatusCode"]>
): ReturnType<WhatsAppLightModule["getStatusCode"]> {
  return getLightExport("getStatusCode")(...args);
}

export function pickWebChannel(
  ...args: Parameters<WhatsAppLightModule["pickWebChannel"]>
): ReturnType<WhatsAppLightModule["pickWebChannel"]> {
  return getLightExport("pickWebChannel")(...args);
}

export function resolveWaWebAuthDir(): WhatsAppLightModule["WA_WEB_AUTH_DIR"] {
  return getLightExport("WA_WEB_AUTH_DIR");
}

export async function handleWhatsAppAction(
  ...args: Parameters<WhatsAppHeavyModule["handleWhatsAppAction"]>
): ReturnType<WhatsAppHeavyModule["handleWhatsAppAction"]> {
  return (await getHeavyExport("handleWhatsAppAction"))(...args);
}

export async function loadWebMedia(
  ...args: Parameters<typeof loadWebMediaImpl>
): ReturnType<typeof loadWebMediaImpl> {
  return await loadWebMediaImpl(...args);
}

export async function loadWebMediaRaw(
  ...args: Parameters<typeof loadWebMediaRawImpl>
): ReturnType<typeof loadWebMediaRawImpl> {
  return await loadWebMediaRawImpl(...args);
}

export function monitorWebChannel(
  ...args: Parameters<WhatsAppHeavyModule["monitorWebChannel"]>
): ReturnType<WhatsAppHeavyModule["monitorWebChannel"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.monitorWebChannel(...args));
}

export async function monitorWebInbox(
  ...args: Parameters<WhatsAppHeavyModule["monitorWebInbox"]>
): ReturnType<WhatsAppHeavyModule["monitorWebInbox"]> {
  return (await getHeavyExport("monitorWebInbox"))(...args);
}

export async function optimizeImageToJpeg(
  ...args: Parameters<typeof optimizeImageToJpegImpl>
): ReturnType<typeof optimizeImageToJpegImpl> {
  return await optimizeImageToJpegImpl(...args);
}

export async function runWebHeartbeatOnce(
  ...args: Parameters<WhatsAppHeavyModule["runWebHeartbeatOnce"]>
): ReturnType<WhatsAppHeavyModule["runWebHeartbeatOnce"]> {
  return (await getHeavyExport("runWebHeartbeatOnce"))(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<WhatsAppHeavyModule["startWebLoginWithQr"]>
): ReturnType<WhatsAppHeavyModule["startWebLoginWithQr"]> {
  return (await getHeavyExport("startWebLoginWithQr"))(...args);
}

export async function waitForWaConnection(
  ...args: Parameters<WhatsAppHeavyModule["waitForWaConnection"]>
): ReturnType<WhatsAppHeavyModule["waitForWaConnection"]> {
  return (await getHeavyExport("waitForWaConnection"))(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WhatsAppHeavyModule["waitForWebLogin"]>
): ReturnType<WhatsAppHeavyModule["waitForWebLogin"]> {
  return (await getHeavyExport("waitForWebLogin"))(...args);
}

export const extractMediaPlaceholder = (
  ...args: Parameters<WhatsAppHeavyModule["extractMediaPlaceholder"]>
) => loadCurrentHeavyModuleSync().extractMediaPlaceholder(...args);

export const extractText = (...args: Parameters<WhatsAppHeavyModule["extractText"]>) =>
  loadCurrentHeavyModuleSync().extractText(...args);

export function getDefaultLocalRoots(
  ...args: Parameters<typeof getDefaultLocalRootsImpl>
): ReturnType<typeof getDefaultLocalRootsImpl> {
  return getDefaultLocalRootsImpl(...args);
}

export function resolveHeartbeatRecipients(
  ...args: Parameters<typeof resolveWhatsAppHeartbeatRecipients>
): ReturnType<typeof resolveWhatsAppHeartbeatRecipients> {
  return resolveWhatsAppHeartbeatRecipients(...args);
}
