import { createJiti } from "jiti";
import { resolveWhatsAppHeartbeatRecipients } from "../../channels/plugins/whatsapp-heartbeat.js";
import {
  getDefaultLocalRoots as getDefaultLocalRootsImpl,
  loadWebMedia as loadWebMediaImpl,
  loadWebMediaRaw as loadWebMediaRawImpl,
  optimizeImageToJpeg as optimizeImageToJpegImpl,
} from "../../media/web-media.js";
import {
  loadPluginBoundaryModuleWithJiti,
  resolvePluginRuntimeModulePath,
  resolvePluginRuntimeRecord,
} from "./runtime-plugin-boundary.js";
import type {
  WhatsAppHeavyRuntimeModule,
  WhatsAppLightRuntimeModule,
} from "./runtime-whatsapp-surface.js";

const WHATSAPP_PLUGIN_ID = "whatsapp";

type WhatsAppPluginRecord = {
  origin: string;
  rootDir?: string;
  source: string;
};

let cachedHeavyModulePath: string | null = null;
let cachedHeavyModule: WhatsAppHeavyRuntimeModule | null = null;
let cachedLightModulePath: string | null = null;
let cachedLightModule: WhatsAppLightRuntimeModule | null = null;

const jitiLoaders = new Map<boolean, ReturnType<typeof createJiti>>();

function resolveWhatsAppPluginRecord(): WhatsAppPluginRecord {
  return resolvePluginRuntimeRecord(WHATSAPP_PLUGIN_ID, () => {
    throw new Error(
      `WhatsApp plugin runtime is unavailable: missing plugin '${WHATSAPP_PLUGIN_ID}'`,
    );
  }) as WhatsAppPluginRecord;
}

function resolveWhatsAppRuntimeModulePath(
  record: WhatsAppPluginRecord,
  entryBaseName: "light-runtime-api" | "runtime-api",
): string {
  const modulePath = resolvePluginRuntimeModulePath(record, entryBaseName, () => {
    throw new Error(
      `WhatsApp plugin runtime is unavailable: missing ${entryBaseName} for plugin '${WHATSAPP_PLUGIN_ID}'`,
    );
  });
  if (!modulePath) {
    throw new Error(
      `WhatsApp plugin runtime is unavailable: missing ${entryBaseName} for plugin '${WHATSAPP_PLUGIN_ID}'`,
    );
  }
  return modulePath;
}

function loadCurrentHeavyModuleSync(): WhatsAppHeavyRuntimeModule {
  const modulePath = resolveWhatsAppRuntimeModulePath(resolveWhatsAppPluginRecord(), "runtime-api");
  return loadPluginBoundaryModuleWithJiti<WhatsAppHeavyRuntimeModule>(modulePath, jitiLoaders);
}

function loadWhatsAppLightModule(): WhatsAppLightRuntimeModule {
  const modulePath = resolveWhatsAppRuntimeModulePath(
    resolveWhatsAppPluginRecord(),
    "light-runtime-api",
  );
  if (cachedLightModule && cachedLightModulePath === modulePath) {
    return cachedLightModule;
  }
  const loaded = loadPluginBoundaryModuleWithJiti<WhatsAppLightRuntimeModule>(
    modulePath,
    jitiLoaders,
  );
  cachedLightModulePath = modulePath;
  cachedLightModule = loaded;
  return loaded;
}

async function loadWhatsAppHeavyModule(): Promise<WhatsAppHeavyRuntimeModule> {
  const record = resolveWhatsAppPluginRecord();
  const modulePath = resolveWhatsAppRuntimeModulePath(record, "runtime-api");
  if (cachedHeavyModule && cachedHeavyModulePath === modulePath) {
    return cachedHeavyModule;
  }
  const loaded = loadPluginBoundaryModuleWithJiti<WhatsAppHeavyRuntimeModule>(
    modulePath,
    jitiLoaders,
  );
  cachedHeavyModulePath = modulePath;
  cachedHeavyModule = loaded;
  return loaded;
}

function getLightExport<K extends keyof WhatsAppLightRuntimeModule>(
  exportName: K,
): NonNullable<WhatsAppLightRuntimeModule[K]> {
  const loaded = loadWhatsAppLightModule();
  const value = loaded[exportName];
  if (value == null) {
    throw new Error(`WhatsApp plugin runtime is missing export '${String(exportName)}'`);
  }
  return value as NonNullable<WhatsAppLightRuntimeModule[K]>;
}

async function getHeavyExport<K extends keyof WhatsAppHeavyRuntimeModule>(
  exportName: K,
): Promise<NonNullable<WhatsAppHeavyRuntimeModule[K]>> {
  const loaded = await loadWhatsAppHeavyModule();
  const value = loaded[exportName];
  if (value == null) {
    throw new Error(`WhatsApp plugin runtime is missing export '${String(exportName)}'`);
  }
  return value as NonNullable<WhatsAppHeavyRuntimeModule[K]>;
}

export function getActiveWebListener(
  ...args: Parameters<WhatsAppLightRuntimeModule["getActiveWebListener"]>
): ReturnType<WhatsAppLightRuntimeModule["getActiveWebListener"]> {
  return getLightExport("getActiveWebListener")(...args);
}

export function getWebAuthAgeMs(
  ...args: Parameters<WhatsAppLightRuntimeModule["getWebAuthAgeMs"]>
): ReturnType<WhatsAppLightRuntimeModule["getWebAuthAgeMs"]> {
  return getLightExport("getWebAuthAgeMs")(...args);
}

export function logWebSelfId(
  ...args: Parameters<WhatsAppLightRuntimeModule["logWebSelfId"]>
): ReturnType<WhatsAppLightRuntimeModule["logWebSelfId"]> {
  return getLightExport("logWebSelfId")(...args);
}

export function loginWeb(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["loginWeb"]>
): ReturnType<WhatsAppHeavyRuntimeModule["loginWeb"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.loginWeb(...args));
}

export function logoutWeb(
  ...args: Parameters<WhatsAppLightRuntimeModule["logoutWeb"]>
): ReturnType<WhatsAppLightRuntimeModule["logoutWeb"]> {
  return getLightExport("logoutWeb")(...args);
}

export function readWebSelfId(
  ...args: Parameters<WhatsAppLightRuntimeModule["readWebSelfId"]>
): ReturnType<WhatsAppLightRuntimeModule["readWebSelfId"]> {
  return getLightExport("readWebSelfId")(...args);
}

export function webAuthExists(
  ...args: Parameters<WhatsAppLightRuntimeModule["webAuthExists"]>
): ReturnType<WhatsAppLightRuntimeModule["webAuthExists"]> {
  return getLightExport("webAuthExists")(...args);
}

export function sendMessageWhatsApp(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["sendMessageWhatsApp"]>
): ReturnType<WhatsAppHeavyRuntimeModule["sendMessageWhatsApp"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.sendMessageWhatsApp(...args));
}

export function sendPollWhatsApp(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["sendPollWhatsApp"]>
): ReturnType<WhatsAppHeavyRuntimeModule["sendPollWhatsApp"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.sendPollWhatsApp(...args));
}

export function sendReactionWhatsApp(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["sendReactionWhatsApp"]>
): ReturnType<WhatsAppHeavyRuntimeModule["sendReactionWhatsApp"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.sendReactionWhatsApp(...args));
}

export function createRuntimeWhatsAppLoginTool(
  ...args: Parameters<WhatsAppLightRuntimeModule["createWhatsAppLoginTool"]>
): ReturnType<WhatsAppLightRuntimeModule["createWhatsAppLoginTool"]> {
  return getLightExport("createWhatsAppLoginTool")(...args);
}

export function createWaSocket(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["createWaSocket"]>
): ReturnType<WhatsAppHeavyRuntimeModule["createWaSocket"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.createWaSocket(...args));
}

export function formatError(
  ...args: Parameters<WhatsAppLightRuntimeModule["formatError"]>
): ReturnType<WhatsAppLightRuntimeModule["formatError"]> {
  return getLightExport("formatError")(...args);
}

export function getStatusCode(
  ...args: Parameters<WhatsAppLightRuntimeModule["getStatusCode"]>
): ReturnType<WhatsAppLightRuntimeModule["getStatusCode"]> {
  return getLightExport("getStatusCode")(...args);
}

export function pickWebChannel(
  ...args: Parameters<WhatsAppLightRuntimeModule["pickWebChannel"]>
): ReturnType<WhatsAppLightRuntimeModule["pickWebChannel"]> {
  return getLightExport("pickWebChannel")(...args);
}

export function resolveWaWebAuthDir(): WhatsAppLightRuntimeModule["WA_WEB_AUTH_DIR"] {
  return getLightExport("WA_WEB_AUTH_DIR");
}

export async function handleWhatsAppAction(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["handleWhatsAppAction"]>
): ReturnType<WhatsAppHeavyRuntimeModule["handleWhatsAppAction"]> {
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
  ...args: Parameters<WhatsAppHeavyRuntimeModule["monitorWebChannel"]>
): ReturnType<WhatsAppHeavyRuntimeModule["monitorWebChannel"]> {
  return loadWhatsAppHeavyModule().then((loaded) => loaded.monitorWebChannel(...args));
}

export async function monitorWebInbox(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["monitorWebInbox"]>
): ReturnType<WhatsAppHeavyRuntimeModule["monitorWebInbox"]> {
  return (await getHeavyExport("monitorWebInbox"))(...args);
}

export async function optimizeImageToJpeg(
  ...args: Parameters<typeof optimizeImageToJpegImpl>
): ReturnType<typeof optimizeImageToJpegImpl> {
  return await optimizeImageToJpegImpl(...args);
}

export async function runWebHeartbeatOnce(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["runWebHeartbeatOnce"]>
): ReturnType<WhatsAppHeavyRuntimeModule["runWebHeartbeatOnce"]> {
  return (await getHeavyExport("runWebHeartbeatOnce"))(...args);
}

export async function startWebLoginWithQr(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["startWebLoginWithQr"]>
): ReturnType<WhatsAppHeavyRuntimeModule["startWebLoginWithQr"]> {
  return (await getHeavyExport("startWebLoginWithQr"))(...args);
}

export async function waitForWaConnection(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["waitForWaConnection"]>
): ReturnType<WhatsAppHeavyRuntimeModule["waitForWaConnection"]> {
  return (await getHeavyExport("waitForWaConnection"))(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WhatsAppHeavyRuntimeModule["waitForWebLogin"]>
): ReturnType<WhatsAppHeavyRuntimeModule["waitForWebLogin"]> {
  return (await getHeavyExport("waitForWebLogin"))(...args);
}

export const extractMediaPlaceholder = (
  ...args: Parameters<WhatsAppHeavyRuntimeModule["extractMediaPlaceholder"]>
) => loadCurrentHeavyModuleSync().extractMediaPlaceholder(...args);

export const extractText = (...args: Parameters<WhatsAppHeavyRuntimeModule["extractText"]>) =>
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
