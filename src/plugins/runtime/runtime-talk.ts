import { watchTalkActivity } from "../../talk/activity.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeTalk(): PluginRuntime["talk"] {
  return { watchActivity: watchTalkActivity };
}
