import { StringDecoder } from "node:string_decoder";

/** @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return value !== null && typeof value === "object"
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value */
function entries(value) {
  return Array.isArray(value) ? value.slice(-128) : [];
}

/** Observe already-delivered native frames without retaining their payloads.
 * @param {(event: {kind: string, reason: string}) => void} write
 */
export function createQuotaNativeAuthObserver(write) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  /** @param {Buffer | string} chunk */
  return (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (const part of text.split(/(?<=\n)/u)) {
      const ended = part.endsWith("\n");
      if (!dropping) {
        pending += part;
        if (pending.length > 1024 * 1024) {
          pending = "";
          dropping = true;
        }
      }
      if (!ended) continue;
      if (!dropping) {
        let frame;
        try {
          frame = record(JSON.parse(pending));
        } catch {
          // Native diagnostics are not protocol frames; never copy their text.
        }
        if (frame?.method === "account/chatgptAuthTokens/refresh" && frame.id !== undefined) {
          write({
            kind: "native-refresh",
            reason: record(frame.params).reason === "unauthorized" ? "unauthorized" : "unknown",
          });
        }
      }
      pending = "";
      dropping = false;
    }
  };
}

/** @param {unknown} body */
export function quotaRequestMode(body) {
  try {
    const frame = record(JSON.parse(typeof body === "string" ? body : "null"));
    return frame.type === "response.create"
      ? frame.generate === false
        ? "warmup"
        : "inference"
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** @param {unknown} raw */
function endpoint(raw) {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const pathname = raw.split("?")[0];
  if (pathname === "/oauth/token") {
    return "oauth-token";
  }
  if (pathname === "/catalog/models") {
    return "catalog";
  }
  if (pathname === "/core-wham/usage" || pathname === "/backend-api/wham/usage") {
    return "usage";
  }
  if (pathname.endsWith("/responses")) {
    return "responses";
  }
  return "other";
}

const phases = new Set(["healthy", "initial-exhaustion", "restored"]);
const statuses = new Set(["ok", "expiring", "expired", "missing", "static"]);

/** Only allowlisted facts leave the synthetic fixture; raw evidence stays local.
 * @param {unknown} input
 */
export function quotaPublicDiagnostics(input) {
  const source = record(input);
  const profile = record(source.profile);
  const authEvents = Array.isArray(source.authEvents) ? source.authEvents : [];
  const refreshes = authEvents.filter((event) => record(event).kind === "oauth-token");
  const nativeAuth = authEvents.filter((event) =>
    ["native-observer", "native-refresh"].includes(record(event).kind),
  );
  const nativeLog = typeof source.nativeLog === "string" ? source.nativeLog : "";
  const handshakeFailures = nativeLog.split("\n").flatMap((line) => {
    if (
      !line.includes("codex app-server stderr:") ||
      !line.includes("failed to connect to websocket:")
    ) {
      return [];
    }
    const http = /HTTP error:\s*([45]\d{2})\b/u.exec(line);
    return [{ kind: http ? "http" : "unknown", httpStatus: http ? Number(http[1]) : null }];
  });
  return {
    // Test-artifact schema only; no product API or stored auth format changes.
    schemaVersion: 2,
    omitted: {
      requests: Math.max(0, (Array.isArray(source.requests) ? source.requests.length : 0) - 128),
      upgrades: Math.max(0, (Array.isArray(source.upgrades) ? source.upgrades.length : 0) - 128),
      refreshes: Math.max(0, refreshes.length - 128),
      nativeAuth: Math.max(0, nativeAuth.length - 128),
      responses: Math.max(0, (Array.isArray(source.responses) ? source.responses.length : 0) - 128),
      handshakeFailures: Math.max(0, handshakeFailures.length - 128),
    },
    refreshReceiptAvailable: Array.isArray(source.authEvents),
    authCaptureTruncated: authEvents.some((event) => record(event).kind === "truncated"),
    nativeLogAvailable: typeof source.nativeLog === "string",
    profile: {
      status:
        typeof profile.status === "string" && statuses.has(profile.status)
          ? profile.status
          : "unknown",
      expiresAt: finiteNumber(profile.expiresAt),
      remainingMs: finiteNumber(profile.remainingMs),
    },
    requests: entries(source.requests).map((entry) => {
      const value = record(entry);
      return {
        atMs: finiteNumber(value.atMs),
        phase: typeof value.phase === "string" && phases.has(value.phase) ? value.phase : "other",
        transport:
          value.transport === "http" || value.transport === "websocket"
            ? value.transport
            : "unknown",
        endpoint: endpoint(value.path),
      };
    }),
    upgrades: entries(source.upgrades).map((entry) => ({
      atMs: finiteNumber(record(entry).atMs),
      endpoint: endpoint(record(entry).path),
    })),
    refreshes: entries(refreshes).map((entry) => ({ atMs: finiteNumber(record(entry).atMs) })),
    nativeAuth: entries(nativeAuth).map((entry) => {
      const value = record(entry);
      return {
        atMs: finiteNumber(value.atMs),
        kind: value.kind === "native-refresh" ? "refresh" : "observer-attached",
        method: value.kind === "native-refresh" ? "account/chatgptAuthTokens/refresh" : null,
        reason: value.reason === "unauthorized" ? "unauthorized" : "unknown",
      };
    }),
    responses: entries(source.responses).map((entry) => {
      const value = record(entry);
      const status =
        typeof value.status === "number" &&
        Number.isInteger(value.status) &&
        value.status >= 100 &&
        value.status <= 599
          ? value.status
          : null;
      return {
        atMs: finiteNumber(value.atMs),
        phase: typeof value.phase === "string" && phases.has(value.phase) ? value.phase : "other",
        transport:
          value.transport === "http" || value.transport === "websocket"
            ? value.transport
            : "unknown",
        endpoint: endpoint(value.path),
        status,
        statusClass: status === null ? "unknown" : `${Math.floor(status / 100)}xx`,
        mode: value.mode === "warmup" || value.mode === "inference" ? value.mode : "unknown",
      };
    }),
    handshakeFailures: handshakeFailures.slice(-128),
  };
}
