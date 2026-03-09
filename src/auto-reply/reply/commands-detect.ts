import { detectDeepfake } from "../../detect/resemble-detect.js";
import type { CommandHandler } from "./commands-types.js";

export const handleDetectCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/detect ") && body !== "/detect") {
    return null;
  }

  const url = body.slice(8).trim();
  if (!url) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Please provide a media URL.\nUsage: /detect <url>",
      },
    };
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Invalid protocol");
    }
  } catch {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Please provide a valid HTTP or HTTPS media URL.\nUsage: /detect <url>",
      },
    };
  }

  const result = await detectDeepfake(url, params.cfg);

  if (!result.success) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Detection failed: ${result.error}` },
    };
  }

  const item = result.item;
  if (!item) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Invalid response from Resemble API." },
    };
  }

  let text = `🕵️‍♂️ **Media Verification Report**\nType: ${item.media_type}\n`;

  if (item.media_type === "video" && item.video_metrics) {
    const vm = item.video_metrics;
    text += `Status: ${vm.label}\nConfidence: ${Math.round(vm.score * 100)}% (Certainty: ${Math.round(vm.certainty * 100)}%)\n`;
  } else if (item.media_type === "audio" && item.metrics) {
    const am = item.metrics;
    text += `Status: ${am.label}\nAggregated Score: ${am.aggregated_score}\n`;
  } else if (item.media_type === "image" && item.image_metrics) {
    const im = item.image_metrics;
    text += `Status: ${im.label}\nScore: ${Math.round(im.score * 100)}%\nType: ${im.type}\n`;
  } else {
    text += `Status: Analyzed\n`;
  }

  return {
    shouldContinue: false,
    reply: { text },
  };
};
