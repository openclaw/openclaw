import { loginWeb as loginWebImpl } from "../../../extensions/whatsapp/src/login.js";

type LoginWeb = typeof import("../../../extensions/whatsapp/src/login.js").loginWeb;

export function loginWeb(...args: Parameters<LoginWeb>): ReturnType<LoginWeb> {
  return loginWebImpl(...args);
}
