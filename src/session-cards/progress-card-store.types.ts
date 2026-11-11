import type { ProgressCard } from "../../packages/gateway-protocol/src/index.js";
import type { ProgressCardWrite } from "./progress-card-values.js";

export interface ProgressCardStore {
  get(sessionKey: string, agentId?: string): Promise<ProgressCard | null>;
  put(
    sessionKey: string,
    input: ProgressCardWrite & { assertCurrent?: () => void },
    agentId?: string,
  ): Promise<{ card: ProgressCard | null }>;
}
