type SlotAction = "save" | "restore" | "erase";

/**
 * Client for the llama.cpp server KV cache slot API.
 * POST {serverUrl}/slots/{slotId}  body: { action, filename }
 * All operations are fire-and-forget — they never throw.
 */
export class LlamaCppCacheService {
  constructor(private readonly debug = false) {}

  async saveSlot(serverUrl: string, slotId: number, filename: string): Promise<void> {
    await this.#slotAction(serverUrl, slotId, "save", filename);
  }

  async restoreSlot(serverUrl: string, slotId: number, filename: string): Promise<void> {
    await this.#slotAction(serverUrl, slotId, "restore", filename);
  }

  async eraseSlot(serverUrl: string, slotId: number, filename: string): Promise<void> {
    await this.#slotAction(serverUrl, slotId, "erase", filename);
  }

  async #slotAction(
    serverUrl: string,
    slotId: number,
    action: SlotAction,
    filename: string,
  ): Promise<void> {
    const url = `${serverUrl.replace(/\/$/, "")}/slots/${slotId}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, filename }),
        signal: AbortSignal.timeout(5000),
      });
      if (this.debug && !res.ok) {
        console.debug(
          `[LlamaCppCache] ${action} slot=${slotId} file=${filename} → HTTP ${res.status}`,
        );
      }
    } catch (err) {
      if (this.debug) {
        console.debug(
          `[LlamaCppCache] ${action} slot=${slotId} file=${filename} error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
