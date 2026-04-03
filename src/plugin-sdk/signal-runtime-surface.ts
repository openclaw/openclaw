import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

type SignalRuntimeModule = typeof import("../../extensions/signal/runtime-api.js");

type SignalRuntimeSurface = Pick<
  SignalRuntimeModule,
  "monitorSignalProvider" | "probeSignal" | "sendMessageSignal" | "signalMessageActions"
>;

function loadSignalRuntimeSurface(): SignalRuntimeSurface {
  return loadBundledPluginPublicSurfaceModuleSync<SignalRuntimeSurface>({
    dirName: "signal",
    artifactBasename: "runtime-api.js",
  });
}

export const signalMessageActions: SignalRuntimeModule["signalMessageActions"] =
  createLazyFacadeObjectValue(() => loadSignalRuntimeSurface().signalMessageActions);

export const monitorSignalProvider: SignalRuntimeModule["monitorSignalProvider"] = ((...args) =>
  loadSignalRuntimeSurface().monitorSignalProvider(
    ...args,
  )) as SignalRuntimeModule["monitorSignalProvider"];

export const probeSignal: SignalRuntimeModule["probeSignal"] = ((...args) =>
  loadSignalRuntimeSurface().probeSignal(...args)) as SignalRuntimeModule["probeSignal"];

export const sendMessageSignal: SignalRuntimeModule["sendMessageSignal"] = ((...args) =>
  loadSignalRuntimeSurface().sendMessageSignal(
    ...args,
  )) as SignalRuntimeModule["sendMessageSignal"];
