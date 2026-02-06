// KOOK Connection Probe

import { getKookGateway } from "./api.js";

export type KookProbeResult = {
  success: boolean;
  gatewayUrl?: string;
  error?: string;
};

/**
 * Probe KOOK connection (test token validity)
 */
export async function probeKook(token: string, timeoutMs: number = 5000): Promise<KookProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const gatewayUrl = await getKookGateway(token);
    clearTimeout(timeout);
    return {
      success: true,
      gatewayUrl,
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
