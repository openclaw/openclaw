// Runtime boundary for @whiskeysockets/baileys (optional dependency).
// Use getBaileys() in async contexts to load baileys lazily.
// Use getBaileysSync() in sync helpers that are only reachable after getBaileys() has resolved.
// Never statically import values from @whiskeysockets/baileys outside this file;
// use import type for type-only references (erased at compile time).

let _baileys: typeof import("@whiskeysockets/baileys") | undefined;

export async function getBaileys(): Promise<typeof import("@whiskeysockets/baileys")> {
  if (!_baileys) {
    _baileys = await import("@whiskeysockets/baileys").catch((err: unknown) => {
      throw new Error(
        "WhatsApp unavailable: @whiskeysockets/baileys is not installed. Run: npm install @whiskeysockets/baileys",
        { cause: err },
      );
    });
  }
  return _baileys;
}

// Sync accessor – only safe after getBaileys() has been awaited at least once.
// Callers in synchronous helpers (e.g. extract.ts) rely on the async call chain
// (createWaSocket → getBaileys) having already resolved before any messages arrive.
export function getBaileysSync(): typeof import("@whiskeysockets/baileys") {
  if (!_baileys) {
    throw new Error(
      "WhatsApp unavailable: @whiskeysockets/baileys is not installed. Run: npm install @whiskeysockets/baileys",
    );
  }
  return _baileys;
}
