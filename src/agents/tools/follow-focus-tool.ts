import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

export function createFollowFocusTool(): AnyAgentTool {
  return {
    label: "Follow Focus",
    name: "follow_focus",
    description:
      "Request the UI to focus on a specific mode (like vnc or images) to show current progress or screenshots to the user.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["vnc", "images", "browser"],
          description: "The UI mode to focus on.",
        },
        imageUrl: {
          type: "string",
          description:
            "If mode is 'images', provide the absolute path of the local image file to display.",
        },
        reason: {
          type: "string",
          description: "An optional reason to display to the user for why this focus is requested.",
        },
      },
      required: ["mode"],
    },
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const mode = readStringParam(params, "mode", { required: true });
      const imageUrl = readStringParam(params, "imageUrl");
      const reason = readStringParam(params, "reason");

      // The actual side effect happens purely via the tool stream event sent to the frontend.
      // We just need to return success.
      return jsonResult({
        status: "ok",
        delivered: true,
        focus_requested: mode,
        imageUrl,
        reason,
      });
    },
  };
}
