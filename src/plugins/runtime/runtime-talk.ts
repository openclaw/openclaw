import type { PluginRuntime } from "./types.js";

export function createRuntimeTalk(): PluginRuntime["talk"] {
  return {
    openSession: async (params) => {
      const runtime = await import("../../gateway/talk-plugin-session.js");
      return await runtime.openPluginTalkSession(params);
    },
  };
}
