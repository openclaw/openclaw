// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/line/runtime-api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "line",
    artifactBasename: "runtime-api.js",
  });
}
export const createActionCard: FacadeModule["createActionCard"] = ((...args) =>
  loadFacadeModule()["createActionCard"](...args)) as FacadeModule["createActionCard"];
export const createAgendaCard: FacadeModule["createAgendaCard"] = ((...args) =>
  loadFacadeModule()["createAgendaCard"](...args)) as FacadeModule["createAgendaCard"];
export const createAppleTvRemoteCard: FacadeModule["createAppleTvRemoteCard"] = ((...args) =>
  loadFacadeModule()["createAppleTvRemoteCard"](
    ...args,
  )) as FacadeModule["createAppleTvRemoteCard"];
export const createDeviceControlCard: FacadeModule["createDeviceControlCard"] = ((...args) =>
  loadFacadeModule()["createDeviceControlCard"](
    ...args,
  )) as FacadeModule["createDeviceControlCard"];
export const createEventCard: FacadeModule["createEventCard"] = ((...args) =>
  loadFacadeModule()["createEventCard"](...args)) as FacadeModule["createEventCard"];
export const createImageCard: FacadeModule["createImageCard"] = ((...args) =>
  loadFacadeModule()["createImageCard"](...args)) as FacadeModule["createImageCard"];
export const createInfoCard: FacadeModule["createInfoCard"] = ((...args) =>
  loadFacadeModule()["createInfoCard"](...args)) as FacadeModule["createInfoCard"];
export const createListCard: FacadeModule["createListCard"] = ((...args) =>
  loadFacadeModule()["createListCard"](...args)) as FacadeModule["createListCard"];
export const createMediaPlayerCard: FacadeModule["createMediaPlayerCard"] = ((...args) =>
  loadFacadeModule()["createMediaPlayerCard"](...args)) as FacadeModule["createMediaPlayerCard"];
export const createReceiptCard: FacadeModule["createReceiptCard"] = ((...args) =>
  loadFacadeModule()["createReceiptCard"](...args)) as FacadeModule["createReceiptCard"];
export const LineConfigSchema: FacadeModule["LineConfigSchema"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["LineConfigSchema"] as object,
) as FacadeModule["LineConfigSchema"];
export const listLineAccountIds: FacadeModule["listLineAccountIds"] = ((...args) =>
  loadFacadeModule()["listLineAccountIds"](...args)) as FacadeModule["listLineAccountIds"];
export const normalizeAccountId: FacadeModule["normalizeAccountId"] = ((...args) =>
  loadFacadeModule()["normalizeAccountId"](...args)) as FacadeModule["normalizeAccountId"];
export const processLineMessage: FacadeModule["processLineMessage"] = ((...args) =>
  loadFacadeModule()["processLineMessage"](...args)) as FacadeModule["processLineMessage"];
export const resolveDefaultLineAccountId: FacadeModule["resolveDefaultLineAccountId"] = ((
  ...args
) =>
  loadFacadeModule()["resolveDefaultLineAccountId"](
    ...args,
  )) as FacadeModule["resolveDefaultLineAccountId"];
export const resolveExactLineGroupConfigKey: FacadeModule["resolveExactLineGroupConfigKey"] = ((
  ...args
) =>
  loadFacadeModule()["resolveExactLineGroupConfigKey"](
    ...args,
  )) as FacadeModule["resolveExactLineGroupConfigKey"];
export const resolveLineAccount: FacadeModule["resolveLineAccount"] = ((...args) =>
  loadFacadeModule()["resolveLineAccount"](...args)) as FacadeModule["resolveLineAccount"];
export type CardAction = import("@openclaw/line/runtime-api.js").CardAction;
export type LineChannelData = import("@openclaw/line/runtime-api.js").LineChannelData;
export type LineConfig = import("@openclaw/line/runtime-api.js").LineConfig;
export type LineProbeResult = import("@openclaw/line/runtime-api.js").LineProbeResult;
export type ListItem = import("@openclaw/line/runtime-api.js").ListItem;
export type ResolvedLineAccount = import("@openclaw/line/runtime-api.js").ResolvedLineAccount;
