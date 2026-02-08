export type CloseReasonCategory = "PAIRING_REQUIRED" | "UNKNOWN_POLICY" | "OTHER";

export type ParsedWsClose = {
  code: number;
  category: CloseReasonCategory;
  /**
   * Safe, user-displayable reason, only when it exactly matches a known sentinel.
   * Otherwise null.
   */
  safeReason: "PAIRING_REQUIRED" | null;
};

const PAIRING_SENTINEL = "PAIRING_REQUIRED" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseWsClose(code: number, reasonRaw: string): ParsedWsClose {
  const reason = String(reasonRaw ?? "");

  if (code === 1008) {
    if (reason === PAIRING_SENTINEL) {
      return { code, category: "PAIRING_REQUIRED", safeReason: PAIRING_SENTINEL };
    }

    if (reason) {
      try {
        const parsed = JSON.parse(reason) as unknown;
        if (isRecord(parsed) && parsed.error === PAIRING_SENTINEL) {
          return { code, category: "PAIRING_REQUIRED", safeReason: PAIRING_SENTINEL };
        }
      } catch {
        // ignore
      }

      // Other 1008 policy reason, unknown to us.
      return { code, category: "UNKNOWN_POLICY", safeReason: null };
    }

    return { code, category: "UNKNOWN_POLICY", safeReason: null };
  }

  return { code, category: "OTHER", safeReason: null };
}
