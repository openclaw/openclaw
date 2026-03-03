/**
 * Himalaya CLI Wrapper
 *
 * Typed wrappers around himalaya CLI invocations for IMAP operations.
 * All commands use `-o json --quiet` for structured, parseable output.
 */

import { runCommandWithTimeout } from "../process/exec.js";

export type HimalayaEnvelope = {
  id: string;
  from: string;
  subject: string;
  date: string;
  flags: string[];
};

export type HimalayaMessage = {
  /** The raw text body of the message. */
  body: string;
};

/** Global args that go BEFORE the subcommand (config, output format, quiet). */
function globalArgs(params: { config?: string }): string[] {
  const args: string[] = ["-o", "json", "--quiet"];
  if (params.config) {
    args.push("-c", params.config);
  }
  return args;
}

/** Per-subcommand args that go AFTER the subcommand name (-a account, -f folder, etc). */
function accountArgs(account?: string): string[] {
  return account ? ["-a", account] : [];
}

/**
 * List envelopes matching a query from a given folder.
 * Returns structured envelope data via himalaya's JSON output.
 */
export async function listEnvelopes(params: {
  account?: string;
  folder: string;
  query: string;
  pageSize: number;
  config?: string;
}): Promise<HimalayaEnvelope[]> {
  const args = [
    "himalaya",
    ...globalArgs(params),
    "envelope",
    "list",
    ...accountArgs(params.account),
    "-f",
    params.folder,
    "-s",
    String(params.pageSize),
  ];

  // Append query tokens (e.g. "flag unseen" → ["flag", "unseen"])
  const queryTokens = params.query.trim().split(/\s+/).filter(Boolean);
  if (queryTokens.length > 0) {
    args.push(...queryTokens);
  }

  const cmdStr = args.join(" ");
  console.error(`[imap-himalaya] executing: ${cmdStr}`);
  const result = await runCommandWithTimeout(args, { timeoutMs: 30_000 });
  console.error(
    `[imap-himalaya] exit code: ${result.code}, stdout length: ${result.stdout.length}, stderr: ${result.stderr?.slice(0, 200) || "(none)"}`,
  );
  if (result.code !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || "himalaya envelope list failed";
    throw new Error(msg);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return [];
  }

  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map(normalizeEnvelope);
}

/**
 * Read a single message by envelope ID.
 * Returns the message body text.
 */
export async function readMessage(params: {
  account?: string;
  id: string;
  folder: string;
  config?: string;
  /** When true, read without marking as seen. */
  preview?: boolean;
}): Promise<HimalayaMessage> {
  const args = [
    "himalaya",
    ...globalArgs(params),
    "message",
    "read",
    ...accountArgs(params.account),
    "-f",
    params.folder,
  ];
  if (params.preview) {
    args.push("-p");
  }
  args.push("--no-headers");
  args.push(params.id);

  const result = await runCommandWithTimeout(args, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || "himalaya message read failed";
    throw new Error(msg);
  }

  // With --no-headers and plain output, the body is the raw stdout.
  // With JSON output, it may be a JSON string.
  const stdout = result.stdout;
  let body: string;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    body = typeof parsed === "string" ? parsed : String(stdout);
  } catch {
    body = stdout;
  }

  return { body: body.trim() };
}

/**
 * Mark an envelope as seen by adding the "seen" flag.
 */
export async function markEnvelopeSeen(params: {
  account?: string;
  id: string;
  folder: string;
  config?: string;
}): Promise<void> {
  const args = [
    "himalaya",
    ...globalArgs(params),
    "flag",
    "add",
    ...accountArgs(params.account),
    "-f",
    params.folder,
    params.id,
    "seen",
  ];

  const result = await runCommandWithTimeout(args, { timeoutMs: 15_000 });
  if (result.code !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || "himalaya flag add failed";
    throw new Error(msg);
  }
}

/**
 * Check that himalaya is reachable and the account is valid.
 */
export async function checkAccount(params: {
  account?: string;
  config?: string;
}): Promise<{ ok: boolean; error?: string }> {
  // account doctor takes the account as a positional arg, not via -a
  const args = ["himalaya", ...globalArgs(params), "account", "doctor"];
  if (params.account) {
    args.push(params.account);
  }

  const result = await runCommandWithTimeout(args, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr?.trim() || result.stdout?.trim() || "himalaya account doctor failed",
    };
  }
  return { ok: true };
}

// -- internal helpers --

function toStr(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizeEnvelope(raw: unknown): HimalayaEnvelope {
  if (!raw || typeof raw !== "object") {
    return { id: "", from: "", subject: "", date: "", flags: [] };
  }
  const obj = raw as Record<string, unknown>;
  return {
    id: toStr(obj.id),
    from: normalizeFrom(obj.from),
    subject: toStr(obj.subject),
    date: toStr(obj.date),
    flags: Array.isArray(obj.flags) ? obj.flags.map((f) => toStr(f)) : [],
  };
}

function normalizeFrom(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  // himalaya may return from as an object { name, addr } or array
  if (Array.isArray(value)) {
    return value.map((v) => normalizeFrom(v)).join(", ");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const name = toStr(obj.name);
    const addr = toStr(obj.addr);
    return name ? `${name} <${addr}>` : addr;
  }
  return toStr(value);
}
