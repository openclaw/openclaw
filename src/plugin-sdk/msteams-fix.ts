import { createPluginRuntimeStore } from "./core.js";

/**
 * Shared runtime store for MSTeams to prevent singleton mismatch between extension and gateway.
 * Addresses #53953.
 */
const msteamsRuntimeStore = createPluginRuntimeStore<any>("msteams");

export const getMSTeamsRuntime = msteamsRuntimeStore.get;
export const setMSTeamsRuntime = msteamsRuntimeStore.set;
