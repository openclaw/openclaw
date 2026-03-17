import { loginWeb as loginWebImpl } from "../../../extensions/whatsapp/runtime-api.js";
import type { PluginRuntime } from "./types.js";

type RuntimeWhatsAppLogin = Pick<PluginRuntime["channel"]["whatsapp"], "loginWeb">;

export const runtimeWhatsAppLogin = {
  loginWeb: loginWebImpl,
} satisfies RuntimeWhatsAppLogin;
