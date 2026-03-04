/**
 * Bulk channel operations
 * 
 * Select multiple channels and apply operations:
 * - Enable/disable channels
 * - Change model for multiple channels
 * - Copy settings between channels
 * - Batch token rotation
 * - Apply rate limits globally
 */

export type BulkOperation =
  | "enable"
  | "disable"
  | "change-model"
  | "copy-settings"
  | "rotate-tokens"
  | "apply-rate-limit";

export type BulkOperationResult = {
  operation: BulkOperation;
  channelIds: string[];
  succeeded: string[];
  failed: Array<{ channelId: string; error: string }>;
  duration: number;
};

export type ChannelSelection = {
  channelId: string;
  accountId: string;
  enabled: boolean;
  model?: string;
};

/**
 * Apply bulk operation to selected channels
 */
export async function applyBulkOperation(
  operation: BulkOperation,
  selections: ChannelSelection[],
  params: Record<string, any>,
  applyFn: (channelId: string, accountId: string, update: any) => Promise<void>,
): Promise<BulkOperationResult> {
  const startTime = Date.now();
  const result: BulkOperationResult = {
    operation,
    channelIds: selections.map((s) => s.channelId),
    succeeded: [],
    failed: [],
    duration: 0,
  };

  for (const selection of selections) {
    try {
      let update: any = {};

      switch (operation) {
        case "enable":
          update = { enabled: true };
          break;
        case "disable":
          update = { enabled: false };
          break;
        case "change-model":
          update = { model: params.model };
          break;
        case "copy-settings":
          update = { ...params.settings };
          break;
        case "rotate-tokens":
          // This would call a specific token rotation endpoint
          update = { rotateToken: true };
          break;
        case "apply-rate-limit":
          update = {
            rateLimit: {
              requests: params.requests,
              window: params.window,
            },
          };
          break;
      }

      await applyFn(selection.channelId, selection.accountId, update);
      result.succeeded.push(selection.channelId);
    } catch (error) {
      result.failed.push({
        channelId: selection.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Validate bulk operation before applying
 */
export function validateBulkOperation(
  operation: BulkOperation,
  selections: ChannelSelection[],
  params: Record<string, any>,
): { valid: boolean; error?: string } {
  if (selections.length === 0) {
    return { valid: false, error: "No channels selected" };
  }

  switch (operation) {
    case "change-model":
      if (!params.model) {
        return { valid: false, error: "Model not specified" };
      }
      break;
    case "copy-settings":
      if (!params.settings || Object.keys(params.settings).length === 0) {
        return { valid: false, error: "No settings to copy" };
      }
      break;
    case "apply-rate-limit":
      if (!params.requests || !params.window) {
        return {
          valid: false,
          error: "Rate limit parameters (requests, window) required",
        };
      }
      break;
  }

  return { valid: true };
}

/**
 * Get operation description for confirmation dialog
 */
export function getBulkOperationDescription(
  operation: BulkOperation,
  count: number,
  params?: Record<string, any>,
): string {
  const channelText = count === 1 ? "1 channel" : `${count} channels`;

  switch (operation) {
    case "enable":
      return `Enable ${channelText}`;
    case "disable":
      return `Disable ${channelText}`;
    case "change-model":
      return `Change model to "${params?.model}" for ${channelText}`;
    case "copy-settings":
      return `Copy settings to ${channelText}`;
    case "rotate-tokens":
      return `Rotate tokens for ${channelText}`;
    case "apply-rate-limit":
      return `Apply rate limit (${params?.requests} requests per ${params?.window}s) to ${channelText}`;
    default:
      return `Apply operation to ${channelText}`;
  }
}

/**
 * Storage for channel selections (persists across page reloads)
 */
const SELECTIONS_STORAGE_KEY = "openclaw:channelSelections";

export function saveSelections(selections: string[]): void {
  try {
    localStorage.setItem(SELECTIONS_STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // Silent fail
  }
}

export function loadSelections(): string[] {
  try {
    const stored = localStorage.getItem(SELECTIONS_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function clearSelections(): void {
  try {
    localStorage.removeItem(SELECTIONS_STORAGE_KEY);
  } catch {
    // Silent fail
  }
}

/**
 * Quick selection helpers
 */
export function selectAll(channels: ChannelSelection[]): string[] {
  return channels.map((c) => c.channelId);
}

export function selectNone(): string[] {
  return [];
}

export function selectByType(
  channels: ChannelSelection[],
  type: "enabled" | "disabled",
): string[] {
  return channels
    .filter((c) => (type === "enabled" ? c.enabled : !c.enabled))
    .map((c) => c.channelId);
}

export function invertSelection(
  channels: ChannelSelection[],
  current: string[],
): string[] {
  const all = channels.map((c) => c.channelId);
  return all.filter((id) => !current.includes(id));
}
