// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/line/runtime-api.js");
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "line",
    artifactBasename: "runtime-api.js",
  });
}
export const buildTemplateMessageFromPayload: FacadeModule["buildTemplateMessageFromPayload"] = ((
  ...args
) =>
  loadFacadeModule()["buildTemplateMessageFromPayload"](
    ...args,
  )) as FacadeModule["buildTemplateMessageFromPayload"];
export const cancelDefaultRichMenu: FacadeModule["cancelDefaultRichMenu"] = ((...args) =>
  loadFacadeModule()["cancelDefaultRichMenu"](...args)) as FacadeModule["cancelDefaultRichMenu"];
export const createActionCard: FacadeModule["createActionCard"] = ((...args) =>
  loadFacadeModule()["createActionCard"](...args)) as FacadeModule["createActionCard"];
export const createAgendaCard: FacadeModule["createAgendaCard"] = ((...args) =>
  loadFacadeModule()["createAgendaCard"](...args)) as FacadeModule["createAgendaCard"];
export const createAppleTvRemoteCard: FacadeModule["createAppleTvRemoteCard"] = ((...args) =>
  loadFacadeModule()["createAppleTvRemoteCard"](
    ...args,
  )) as FacadeModule["createAppleTvRemoteCard"];
export const createCarousel: FacadeModule["createCarousel"] = ((...args) =>
  loadFacadeModule()["createCarousel"](...args)) as FacadeModule["createCarousel"];
export const createDefaultMenuConfig: FacadeModule["createDefaultMenuConfig"] = ((...args) =>
  loadFacadeModule()["createDefaultMenuConfig"](
    ...args,
  )) as FacadeModule["createDefaultMenuConfig"];
export const createDeviceControlCard: FacadeModule["createDeviceControlCard"] = ((...args) =>
  loadFacadeModule()["createDeviceControlCard"](
    ...args,
  )) as FacadeModule["createDeviceControlCard"];
export const createEventCard: FacadeModule["createEventCard"] = ((...args) =>
  loadFacadeModule()["createEventCard"](...args)) as FacadeModule["createEventCard"];
export const createGridLayout: FacadeModule["createGridLayout"] = ((...args) =>
  loadFacadeModule()["createGridLayout"](...args)) as FacadeModule["createGridLayout"];
export const createImageCard: FacadeModule["createImageCard"] = ((...args) =>
  loadFacadeModule()["createImageCard"](...args)) as FacadeModule["createImageCard"];
export const createInfoCard: FacadeModule["createInfoCard"] = ((...args) =>
  loadFacadeModule()["createInfoCard"](...args)) as FacadeModule["createInfoCard"];
export const createListCard: FacadeModule["createListCard"] = ((...args) =>
  loadFacadeModule()["createListCard"](...args)) as FacadeModule["createListCard"];
export const createMediaPlayerCard: FacadeModule["createMediaPlayerCard"] = ((...args) =>
  loadFacadeModule()["createMediaPlayerCard"](...args)) as FacadeModule["createMediaPlayerCard"];
export const createNotificationBubble: FacadeModule["createNotificationBubble"] = ((...args) =>
  loadFacadeModule()["createNotificationBubble"](
    ...args,
  )) as FacadeModule["createNotificationBubble"];
export const createQuickReplyItems: FacadeModule["createQuickReplyItems"] = ((...args) =>
  loadFacadeModule()["createQuickReplyItems"](...args)) as FacadeModule["createQuickReplyItems"];
export const createReceiptCard: FacadeModule["createReceiptCard"] = ((...args) =>
  loadFacadeModule()["createReceiptCard"](...args)) as FacadeModule["createReceiptCard"];
export const createRichMenu: FacadeModule["createRichMenu"] = ((...args) =>
  loadFacadeModule()["createRichMenu"](...args)) as FacadeModule["createRichMenu"];
export const createRichMenuAlias: FacadeModule["createRichMenuAlias"] = ((...args) =>
  loadFacadeModule()["createRichMenuAlias"](...args)) as FacadeModule["createRichMenuAlias"];
export const datetimePickerAction: FacadeModule["datetimePickerAction"] = ((...args) =>
  loadFacadeModule()["datetimePickerAction"](...args)) as FacadeModule["datetimePickerAction"];
export const deleteRichMenu: FacadeModule["deleteRichMenu"] = ((...args) =>
  loadFacadeModule()["deleteRichMenu"](...args)) as FacadeModule["deleteRichMenu"];
export const deleteRichMenuAlias: FacadeModule["deleteRichMenuAlias"] = ((...args) =>
  loadFacadeModule()["deleteRichMenuAlias"](...args)) as FacadeModule["deleteRichMenuAlias"];
export const downloadLineMedia: FacadeModule["downloadLineMedia"] = ((...args) =>
  loadFacadeModule()["downloadLineMedia"](...args)) as FacadeModule["downloadLineMedia"];
export const firstDefined: FacadeModule["firstDefined"] = ((...args) =>
  loadFacadeModule()["firstDefined"](...args)) as FacadeModule["firstDefined"];
export const getDefaultRichMenuId: FacadeModule["getDefaultRichMenuId"] = ((...args) =>
  loadFacadeModule()["getDefaultRichMenuId"](...args)) as FacadeModule["getDefaultRichMenuId"];
export const getRichMenu: FacadeModule["getRichMenu"] = ((...args) =>
  loadFacadeModule()["getRichMenu"](...args)) as FacadeModule["getRichMenu"];
export const getRichMenuIdOfUser: FacadeModule["getRichMenuIdOfUser"] = ((...args) =>
  loadFacadeModule()["getRichMenuIdOfUser"](...args)) as FacadeModule["getRichMenuIdOfUser"];
export const getRichMenuList: FacadeModule["getRichMenuList"] = ((...args) =>
  loadFacadeModule()["getRichMenuList"](...args)) as FacadeModule["getRichMenuList"];
export const hasLineDirectives: FacadeModule["hasLineDirectives"] = ((...args) =>
  loadFacadeModule()["hasLineDirectives"](...args)) as FacadeModule["hasLineDirectives"];
export const isSenderAllowed: FacadeModule["isSenderAllowed"] = ((...args) =>
  loadFacadeModule()["isSenderAllowed"](...args)) as FacadeModule["isSenderAllowed"];
export const linkRichMenuToUser: FacadeModule["linkRichMenuToUser"] = ((...args) =>
  loadFacadeModule()["linkRichMenuToUser"](...args)) as FacadeModule["linkRichMenuToUser"];
export const linkRichMenuToUsers: FacadeModule["linkRichMenuToUsers"] = ((...args) =>
  loadFacadeModule()["linkRichMenuToUsers"](...args)) as FacadeModule["linkRichMenuToUsers"];
export const messageAction: FacadeModule["messageAction"] = ((...args) =>
  loadFacadeModule()["messageAction"](...args)) as FacadeModule["messageAction"];
export const monitorLineProvider: FacadeModule["monitorLineProvider"] = ((...args) =>
  loadFacadeModule()["monitorLineProvider"](...args)) as FacadeModule["monitorLineProvider"];
export const normalizeAllowFrom: FacadeModule["normalizeAllowFrom"] = ((...args) =>
  loadFacadeModule()["normalizeAllowFrom"](...args)) as FacadeModule["normalizeAllowFrom"];
export const normalizeDmAllowFromWithStore: FacadeModule["normalizeDmAllowFromWithStore"] = ((
  ...args
) =>
  loadFacadeModule()["normalizeDmAllowFromWithStore"](
    ...args,
  )) as FacadeModule["normalizeDmAllowFromWithStore"];
export const parseLineDirectives: FacadeModule["parseLineDirectives"] = ((...args) =>
  loadFacadeModule()["parseLineDirectives"](...args)) as FacadeModule["parseLineDirectives"];
export const postbackAction: FacadeModule["postbackAction"] = ((...args) =>
  loadFacadeModule()["postbackAction"](...args)) as FacadeModule["postbackAction"];
export const probeLineBot: FacadeModule["probeLineBot"] = ((...args) =>
  loadFacadeModule()["probeLineBot"](...args)) as FacadeModule["probeLineBot"];
export const pushFlexMessage: FacadeModule["pushFlexMessage"] = ((...args) =>
  loadFacadeModule()["pushFlexMessage"](...args)) as FacadeModule["pushFlexMessage"];
export const pushLocationMessage: FacadeModule["pushLocationMessage"] = ((...args) =>
  loadFacadeModule()["pushLocationMessage"](...args)) as FacadeModule["pushLocationMessage"];
export const pushMessageLine: FacadeModule["pushMessageLine"] = ((...args) =>
  loadFacadeModule()["pushMessageLine"](...args)) as FacadeModule["pushMessageLine"];
export const pushMessagesLine: FacadeModule["pushMessagesLine"] = ((...args) =>
  loadFacadeModule()["pushMessagesLine"](...args)) as FacadeModule["pushMessagesLine"];
export const pushTemplateMessage: FacadeModule["pushTemplateMessage"] = ((...args) =>
  loadFacadeModule()["pushTemplateMessage"](...args)) as FacadeModule["pushTemplateMessage"];
export const pushTextMessageWithQuickReplies: FacadeModule["pushTextMessageWithQuickReplies"] = ((
  ...args
) =>
  loadFacadeModule()["pushTextMessageWithQuickReplies"](
    ...args,
  )) as FacadeModule["pushTextMessageWithQuickReplies"];
export const sendMessageLine: FacadeModule["sendMessageLine"] = ((...args) =>
  loadFacadeModule()["sendMessageLine"](...args)) as FacadeModule["sendMessageLine"];
export const setDefaultRichMenu: FacadeModule["setDefaultRichMenu"] = ((...args) =>
  loadFacadeModule()["setDefaultRichMenu"](...args)) as FacadeModule["setDefaultRichMenu"];
export const toFlexMessage: FacadeModule["toFlexMessage"] = ((...args) =>
  loadFacadeModule()["toFlexMessage"](...args)) as FacadeModule["toFlexMessage"];
export const unlinkRichMenuFromUser: FacadeModule["unlinkRichMenuFromUser"] = ((...args) =>
  loadFacadeModule()["unlinkRichMenuFromUser"](...args)) as FacadeModule["unlinkRichMenuFromUser"];
export const unlinkRichMenuFromUsers: FacadeModule["unlinkRichMenuFromUsers"] = ((...args) =>
  loadFacadeModule()["unlinkRichMenuFromUsers"](
    ...args,
  )) as FacadeModule["unlinkRichMenuFromUsers"];
export const uploadRichMenuImage: FacadeModule["uploadRichMenuImage"] = ((...args) =>
  loadFacadeModule()["uploadRichMenuImage"](...args)) as FacadeModule["uploadRichMenuImage"];
export const uriAction: FacadeModule["uriAction"] = ((...args) =>
  loadFacadeModule()["uriAction"](...args)) as FacadeModule["uriAction"];
export type Action = import("@openclaw/line/runtime-api.js").Action;
export type CardAction = import("@openclaw/line/runtime-api.js").CardAction;
export type CreateRichMenuParams = import("@openclaw/line/runtime-api.js").CreateRichMenuParams;
export type FlexBox = import("@openclaw/line/runtime-api.js").FlexBox;
export type FlexBubble = import("@openclaw/line/runtime-api.js").FlexBubble;
export type FlexButton = import("@openclaw/line/runtime-api.js").FlexButton;
export type FlexCarousel = import("@openclaw/line/runtime-api.js").FlexCarousel;
export type FlexComponent = import("@openclaw/line/runtime-api.js").FlexComponent;
export type FlexContainer = import("@openclaw/line/runtime-api.js").FlexContainer;
export type FlexImage = import("@openclaw/line/runtime-api.js").FlexImage;
export type FlexText = import("@openclaw/line/runtime-api.js").FlexText;
export type LineChannelData = import("@openclaw/line/runtime-api.js").LineChannelData;
export type LineConfig = import("@openclaw/line/runtime-api.js").LineConfig;
export type LineProbeResult = import("@openclaw/line/runtime-api.js").LineProbeResult;
export type ListItem = import("@openclaw/line/runtime-api.js").ListItem;
export type ResolvedLineAccount = import("@openclaw/line/runtime-api.js").ResolvedLineAccount;
export type RichMenuArea = import("@openclaw/line/runtime-api.js").RichMenuArea;
export type RichMenuAreaRequest = import("@openclaw/line/runtime-api.js").RichMenuAreaRequest;
export type RichMenuRequest = import("@openclaw/line/runtime-api.js").RichMenuRequest;
export type RichMenuResponse = import("@openclaw/line/runtime-api.js").RichMenuResponse;
export type RichMenuSize = import("@openclaw/line/runtime-api.js").RichMenuSize;
