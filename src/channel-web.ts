// Barrel exports for the web channel pieces. Splitting the original 900+ line
// module keeps responsibilities small and testable.
import { resolveWebChannelAuthDir } from "./plugins/runtime/runtime-web-channel-plugin.js";

export { HEARTBEAT_PROMPT } from "./auto-reply/heartbeat.js";
export { HEARTBEAT_TOKEN } from "./auto-reply/tokens.js";
export { loadWebMedia, optimizeImageToJpeg } from "./media/web-media.js";
export {
  createWebChannelSocket as createWaSocket,
  extractMediaPlaceholder,
  extractText,
  formatError,
  getStatusCode,
  logWebSelfId,
  loginWeb,
  logoutWeb,
  monitorWebChannel,
  monitorWebInbox,
  pickWebChannel,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
  sendWebChannelMessage as sendMessageWhatsApp,
  sendWebChannelReaction as sendReactionWhatsApp,
  waitForWebChannelConnection as waitForWaConnection,
  webAuthExists,
} from "./plugins/runtime/runtime-web-channel-plugin.js";

// Keep the historic constant surface available, but resolve it through the
// web-channel plugin boundary only when a caller actually coerces the value to string.
class LazyWebChannelAuthDir {
  #value: string | null = null;

  #read(): string {
    this.#value ??= resolveWebChannelAuthDir();
    return this.#value;
  }

  toString(): string {
    return this.#read();
  }

  valueOf(): string {
    return this.#read();
  }

  [Symbol.toPrimitive](): string {
    return this.#read();
  }
}

export const WA_WEB_AUTH_DIR = new LazyWebChannelAuthDir() as unknown as string;
