import type { RealtimeVoiceTool } from "./provider-types.js";

export const REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME = "describe_view";

export const REALTIME_VOICE_DESCRIBE_VIEW_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
  description:
    "Describe what the user is currently showing on their camera or screen. Call this when the user asks about what they see, points to an object, or wants help identifying something in view. The caller captures the current frame and injects it directly into the conversation. Describe what you see naturally afterward.",
  parameters: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description:
          "Optional hint about what to focus on, e.g. 'the object in my hand' or 'the writing on the page'.",
      },
    },
    required: [],
  },
};
