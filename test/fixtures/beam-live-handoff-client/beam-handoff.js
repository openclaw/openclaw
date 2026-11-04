import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Source retirement survives CLI restarts and ambiguous network outcomes. Only
// the sanitized, bounded pending payload is retained; credentials never are.
export async function openHandoffs(options, create = true) {
  const file = options.state || path.join(os.homedir(), ".local", "state", "openclaw-beam", "handoffs.sqlite");
  if (!create && !fs.existsSync(file)) return undefined;
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS handoffs (
      endpoint TEXT NOT NULL, beam_id TEXT NOT NULL, payload TEXT,
      publication_id TEXT, receipt TEXT, session_key TEXT,
      PRIMARY KEY(endpoint, beam_id)
    )`);
  return {
    get(endpoint, beamId) {
      return db.prepare("SELECT * FROM handoffs WHERE endpoint=? AND beam_id=?").get(endpoint, beamId);
    },
    begin(endpoint, payload) {
      db.prepare("INSERT OR IGNORE INTO handoffs(endpoint,beam_id,payload) VALUES(?,?,?)")
        .run(endpoint, payload.beamId, JSON.stringify(payload));
      return this.get(endpoint, payload.beamId);
    },
    publication(endpoint, beamId, id) {
      db.prepare("UPDATE handoffs SET publication_id=? WHERE endpoint=? AND beam_id=? AND publication_id IS NULL")
        .run(id, endpoint, beamId);
    },
    acknowledge(endpoint, beamId, receipt) {
      const saved = { beamId, url: receipt.url, handoff: { id: receipt.handoff.id, owner: "gateway", access: receipt.handoff.access } };
      const changed = db.prepare("UPDATE handoffs SET receipt=json_patch(COALESCE(receipt,'{}'),?),payload=NULL,publication_id=? WHERE endpoint=? AND beam_id=? AND (publication_id IS NULL OR publication_id=?) AND (receipt IS NULL OR json_extract(receipt,'$.handoff.id')=?)")
        .run(JSON.stringify(saved), receipt.handoff.id, endpoint, beamId, receipt.handoff.id, receipt.handoff.id);
      if (changed.changes !== 1) throw new Error("A different handoff generation is pending; keep the source retired and reconcile its Beam link");
    },
    destination(endpoint, beamId, sessionKey, sessionId) {
      const receipt = JSON.parse(this.get(endpoint, beamId).receipt);
      db.prepare("UPDATE handoffs SET session_key=?,receipt=? WHERE endpoint=? AND beam_id=?")
        .run(sessionKey, JSON.stringify({ ...receipt, sessionId }), endpoint, beamId);
    },
    close() { db.close(); },
  };
}

export function transferredReceipt(result) {
  return result?.handoff?.owner === "gateway" &&
    /^[a-f0-9]{32}$/.test(result.handoff.id) &&
    ["owned", "shared"].includes(result.handoff.access);
}

export async function releaseSource(state, endpoint, payload, upload) {
  let row = state.get(endpoint, payload.beamId);
  if (!row && !payload.items) throw new Error("No pending handoff exists for this Beam ID; select its exact source transcript for the initial handoff");
  row ??= state.begin(endpoint, payload);
  if (row.receipt) return JSON.parse(row.receipt);
  const frozen = JSON.parse(row.payload);
  if (!row.publication_id) {
    const published = await upload(frozen);
    if (transferredReceipt(published)) {
      state.acknowledge(endpoint, payload.beamId, published);
      return published;
    }
    if (!/^[a-f0-9]{32}$/.test(published.publicationId)) {
      throw new Error("Receiver does not support live handoff; update it before retrying handoff. Source remains retired pending reconciliation.");
    }
    state.publication(endpoint, payload.beamId, published.publicationId);
    row = state.get(endpoint, payload.beamId);
  }
  // Persist the receiver incarnation before release. Retrying an uncertain
  // release can only address that incarnation, never create another publication.
  const result = await upload({ ...frozen, handoffId: row.publication_id });
  if (!transferredReceipt(result) || result.handoff.id !== row.publication_id) {
    throw new Error("Handoff was not acknowledged for this publication; keep the source retired and reconcile its Beam link.");
  }
  state.acknowledge(endpoint, payload.beamId, result);
  return result;
}

function gatewayClient(options, endpoint) {
  if (!options["profile-dir"]) throw new Error("--profile-dir must name your existing authenticated OpenClaw remote profile");
  const dir = path.resolve(options["profile-dir"]);
  if (!fs.existsSync(path.join(dir, "openclaw.json"))) throw new Error("Remote profile is missing; configure your own normal Gateway access first");
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: path.join(dir, "openclaw.json") };
  for (const key of ["OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]) delete env[key];
  const cli = options.cli || "openclaw";
  const invoke = (args) => {
    try {
      return JSON.parse(execFileSync(cli, args, { env, encoding: "utf8", timeout: 130_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      // CLI output can include private config or auth diagnostics. Keep it local.
      throw new Error("OpenClaw request failed; check this remote profile's normal authentication, permissions and Gateway availability");
    }
  };
  if (invoke(["config", "get", "gateway.mode", "--json"]) !== "remote") throw new Error("Profile must use normal Gateway remote mode");
  const configuredUrl = invoke(["config", "get", "gateway.remote.url", "--json"]);
  if (typeof configuredUrl !== "string") throw new Error("Remote profile has no Gateway URL");
  const remote = new URL(configuredUrl);
  if (!["ws:", "wss:"].includes(remote.protocol)) throw new Error("Profile must configure a remote Gateway WebSocket URL");
  const expectedUrl = configuredUrl.trim();
  remote.protocol = remote.protocol === "wss:" ? "https:" : "http:";
  const receiver = new URL(endpoint);
  const base = receiver.pathname.slice(0, -"/api/v1/beam/sessions".length).replace(/\/$/, "");
  if (!receiver.pathname.endsWith("/api/v1/beam/sessions") || remote.origin !== receiver.origin || remote.pathname.replace(/\/$/, "") !== base || remote.search || remote.hash || remote.username || remote.password) {
    throw new Error("Remote profile targets a different Gateway; select the profile for this Beam endpoint");
  }
  return (method, params) => invoke(["gateway", "call", method, "--expect-url", expectedUrl, "--json", "--timeout", "120000", "--params", JSON.stringify(params)]);
}

export function useDestination(state, endpoint, beamId, options, message) {
  const row = state.get(endpoint, beamId);
  const receipt = row?.receipt && JSON.parse(row.receipt);
  if (!transferredReceipt(receipt)) throw new Error("Run handoff for this source and endpoint first; its ownership transfer is not yet acknowledged");
  const call = gatewayClient(options, endpoint);
  const prefix = receipt.handoff.access === "owned" ? "beam.owned" : "sessions.catalog";
  const params = { catalogId: "beam", hostId: "gateway", threadId: beamId, ...(options.agent ? { agentId: options.agent } : {}) };
  let resolved = call(`${prefix}.resolve`, params);
  if (!resolved?.sessionKey && !row.session_key && message === undefined) return { status: "pending", beamId, message: "Source released. No destination turn exists yet; use beam continue with your normal remote profile to start it." };
  if (!resolved?.sessionKey && !row.session_key) resolved = call(`${prefix}.continue`, params);
  const key = resolved?.sessionKey;
  if (typeof key !== "string" || !/^agent:[a-z0-9_-]+:dashboard:[a-z0-9-]+$/i.test(key) || (row.session_key && row.session_key !== key)) throw new Error("Gateway did not return the original authoritative conversation; reopen its Beam link");
  const history = call("chat.history", { sessionKey: key, limit: 100 });
  if (typeof history?.sessionId !== "string" || !history.sessionId || (receipt.sessionId && receipt.sessionId !== history.sessionId)) throw new Error("The destination was deleted or reset; reconcile the original conversation before continuing");
  state.destination(endpoint, beamId, key, history.sessionId);
  // Ordinary chat methods recheck the destination ACL on every call, including
  // after the Beam snapshot expires. Never fall back to a local provider turn.
  return message === undefined
    ? history
    : call("chat.send", { sessionKey: key, sessionId: history.sessionId, message, idempotencyKey: options["request-id"] || randomUUID() });
}
