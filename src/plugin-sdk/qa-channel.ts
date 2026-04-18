// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/qa-channel/api.js");
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "qa-channel",
    artifactBasename: "api.js",
  });
}

export const buildQaTarget: FacadeModule["buildQaTarget"] = ((...args) =>
  loadFacadeModule().buildQaTarget(...args)) as FacadeModule["buildQaTarget"];

export const formatQaTarget: FacadeModule["buildQaTarget"] = ((...args) =>
  loadFacadeModule().buildQaTarget(...args)) as FacadeModule["buildQaTarget"];

export const createQaBusThread: FacadeModule["createQaBusThread"] = ((...args) =>
  loadFacadeModule().createQaBusThread(...args)) as FacadeModule["createQaBusThread"];

export const deleteQaBusMessage: FacadeModule["deleteQaBusMessage"] = ((...args) =>
  loadFacadeModule().deleteQaBusMessage(...args)) as FacadeModule["deleteQaBusMessage"];

export const editQaBusMessage: FacadeModule["editQaBusMessage"] = ((...args) =>
  loadFacadeModule().editQaBusMessage(...args)) as FacadeModule["editQaBusMessage"];

export const getQaBusState: FacadeModule["getQaBusState"] = ((...args) =>
  loadFacadeModule().getQaBusState(...args)) as FacadeModule["getQaBusState"];

export const injectQaBusInboundMessage: FacadeModule["injectQaBusInboundMessage"] = ((...args) =>
  loadFacadeModule().injectQaBusInboundMessage(
    ...args,
  )) as FacadeModule["injectQaBusInboundMessage"];

export const normalizeQaTarget: FacadeModule["normalizeQaTarget"] = ((...args) =>
  loadFacadeModule().normalizeQaTarget(...args)) as FacadeModule["normalizeQaTarget"];

export const parseQaTarget: FacadeModule["parseQaTarget"] = ((...args) =>
  loadFacadeModule().parseQaTarget(...args)) as FacadeModule["parseQaTarget"];

export const pollQaBus: FacadeModule["pollQaBus"] = ((...args) =>
  loadFacadeModule().pollQaBus(...args)) as FacadeModule["pollQaBus"];

export const qaChannelPlugin: FacadeModule["qaChannelPlugin"] = createLazyFacadeObjectValue(
  () => loadFacadeModule().qaChannelPlugin,
);

export const reactToQaBusMessage: FacadeModule["reactToQaBusMessage"] = ((...args) =>
  loadFacadeModule().reactToQaBusMessage(...args)) as FacadeModule["reactToQaBusMessage"];

export const readQaBusMessage: FacadeModule["readQaBusMessage"] = ((...args) =>
  loadFacadeModule().readQaBusMessage(...args)) as FacadeModule["readQaBusMessage"];

export const searchQaBusMessages: FacadeModule["searchQaBusMessages"] = ((...args) =>
  loadFacadeModule().searchQaBusMessages(...args)) as FacadeModule["searchQaBusMessages"];

export const sendQaBusMessage: FacadeModule["sendQaBusMessage"] = ((...args) =>
  loadFacadeModule().sendQaBusMessage(...args)) as FacadeModule["sendQaBusMessage"];

export const setQaChannelRuntime: FacadeModule["setQaChannelRuntime"] = ((...args) =>
  loadFacadeModule().setQaChannelRuntime(...args)) as FacadeModule["setQaChannelRuntime"];

export type QaBusAttachment = import("@openclaw/qa-channel/api.js").QaBusAttachment;
export type QaBusConversation = import("@openclaw/qa-channel/api.js").QaBusConversation;
export type QaBusConversationKind = import("@openclaw/qa-channel/api.js").QaBusConversationKind;
export type QaBusCreateThreadInput = import("@openclaw/qa-channel/api.js").QaBusCreateThreadInput;
export type QaBusDeleteMessageInput = import("@openclaw/qa-channel/api.js").QaBusDeleteMessageInput;
export type QaBusEditMessageInput = import("@openclaw/qa-channel/api.js").QaBusEditMessageInput;
export type QaBusEvent = import("@openclaw/qa-channel/api.js").QaBusEvent;
export type QaBusInboundMessageInput =
  import("@openclaw/qa-channel/api.js").QaBusInboundMessageInput;
export type QaBusMessage = import("@openclaw/qa-channel/api.js").QaBusMessage;
export type QaBusOutboundMessageInput =
  import("@openclaw/qa-channel/api.js").QaBusOutboundMessageInput;
export type QaBusPollInput = import("@openclaw/qa-channel/api.js").QaBusPollInput;
export type QaBusPollResult = import("@openclaw/qa-channel/api.js").QaBusPollResult;
export type QaBusReactToMessageInput =
  import("@openclaw/qa-channel/api.js").QaBusReactToMessageInput;
export type QaBusReadMessageInput = import("@openclaw/qa-channel/api.js").QaBusReadMessageInput;
export type QaBusSearchMessagesInput =
  import("@openclaw/qa-channel/api.js").QaBusSearchMessagesInput;
export type QaBusStateSnapshot = import("@openclaw/qa-channel/api.js").QaBusStateSnapshot;
export type QaBusThread = import("@openclaw/qa-channel/api.js").QaBusThread;
export type QaBusWaitForInput = import("@openclaw/qa-channel/api.js").QaBusWaitForInput;
