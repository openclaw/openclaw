export type GatewaySelfPresence = {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
};

export function pickGatewaySelfPresence(presence: unknown): GatewaySelfPresence | null {
  if (!Array.isArray(presence)) {
    return null;
  }
  const entries = presence as Array<Record<string, unknown>>;
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ??
    // Back-compat: older presence payloads only included a `text` line.
    entries.find((e) => typeof e.text === "string" && String(e.text).startsWith("Gateway:")) ??
    null;
  if (!self) {
    return null;
  }
  return {
    host: typeof self.host === "string" ? self.host : undefined,
    ip: typeof self.ip === "string" ? self.ip : undefined,
    version: typeof self.version === "string" ? self.version : undefined,
    platform: typeof self.platform === "string" ? self.platform : undefined,
  };
}
