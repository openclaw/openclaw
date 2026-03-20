// Barrel exports for the web channel pieces. Splitting the original 900+ line
// module keeps responsibilities small and testable.
import { resolveWaWebAuthDir } from "./plugins/runtime/runtime-whatsapp-boundary.js";

export { HEARTBEAT_PROMPT } from "./auto-reply/heartbeat.js";
export { HEARTBEAT_TOKEN } from "./auto-reply/tokens.js";
export { loadWebMedia, optimizeImageToJpeg } from "./media/web-media.js";
export {
  createWaSocket,
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
  sendMessageWhatsApp,
  sendReactionWhatsApp,
  waitForWaConnection,
  webAuthExists,
} from "./plugins/runtime/runtime-whatsapp-boundary.js";

// Keep the historic constant surface available, but resolve it through the
// plugin boundary only when a caller actually coerces the value to string.
class LazyWhatsAppAuthDir {
  #value: string | null = null;

  #read(): string {
    this.#value ??= resolveWaWebAuthDir();
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

export const WA_WEB_AUTH_DIR = new LazyWhatsAppAuthDir() as unknown as string;
