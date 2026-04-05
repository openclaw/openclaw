import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { MullusiConfig } from "../../config/types.js";

export { resolveActiveTalkProviderConfig };

export function getRuntimeConfigSnapshot(): MullusiConfig | null {
  return null;
}
