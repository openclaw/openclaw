import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import type {
  ClientCredentialOperation,
  ClientCredentialResult,
} from "./client-credential-store.js";
import { hasErrnoCode } from "./errno.js";
import { resolveRequiredOsHomeDir } from "./home-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
import { resolveDatabasePathKey } from "./sqlite-worker-identity.js";

const identity = z.object({
  identity_key: z.string(),
  device_id: z.string(),
  public_key_pem: z.string(),
  private_key_pem: z.string(),
  created_at_ms: z.number(),
  updated_at_ms: z.number(),
});
const token = z.object({
  device_id: z.string(),
  role: z.string(),
  token: z.string(),
  scopes_json: z.string(),
  updated_at_ms: z.number(),
});
const socket = z.object({
  socket_key: z.literal("current"),
  socket_path: z.string().nullable(),
  socket_token: z.string().nullable(),
  updated_at_ms: z.number(),
});
const resultSchema: z.ZodType<ClientCredentialResult> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity"), identity: identity.nullable() }),
  z.object({
    kind: z.literal("identityRepair"),
    identity,
    repaired: z.boolean(),
    rotated: z.boolean(),
  }),
  z.object({ kind: z.literal("token"), token: token.nullable() }),
  z.object({ kind: z.literal("tokens"), tokens: z.array(token), nextRole: z.string().nullable() }),
  z.object({ kind: z.literal("socket"), socket: socket.nullable() }),
  z.object({ kind: z.literal("changed"), changed: z.boolean() }),
  z.object({ kind: z.literal("cleared"), count: z.number().int().nonnegative() }),
]);
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: resultSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

/** AppProfile's control endpoint follows the OS home, independently of the client root. */
function controlDirectory(env: NodeJS.ProcessEnv): string {
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (
    profile &&
    profile.toLowerCase() !== "default" &&
    (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) || ["gateway", "mac", "node"].includes(profile))
  ) {
    throw new Error("Client credentials require a valid macOS app profile.");
  }
  return path.join(
    resolveRequiredOsHomeDir(env),
    `.openclaw${profile && profile.toLowerCase() !== "default" ? `-${profile}` : ""}`,
  );
}

export async function requestClientCredentialsFromApp(
  env: NodeJS.ProcessEnv,
  operation: ClientCredentialOperation,
  signal?: AbortSignal,
  assertCurrent?: () => void,
): Promise<ClientCredentialResult | undefined> {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const directory = controlDirectory(env);
  const tokenPath = path.join(directory, "mac-control.token");
  const handle = await fs
    .open(tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    .catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
  if (!handle) {
    return undefined;
  }
  let secret: string;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 256 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error("App control credentials are unsafe; restart the matching OpenClaw app.");
    }
    secret = (await handle.readFile("utf8")).replace(/\n+$/, "");
    if (!secret) {
      throw new Error("App control credentials are empty; restart the matching OpenClaw app.");
    }
  } finally {
    await handle.close();
  }
  signal?.throwIfAborted();
  assertCurrent?.();
  const requestJson = JSON.stringify({
    operation: "client.credentials",
    credentialRoot: resolveDatabasePathKey(resolveStateDir(env)),
    credentialOperation: operation,
  });
  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const requestLine = JSON.stringify({
    id: crypto.randomUUID(),
    nonce,
    ts,
    requestJson,
    hmac: crypto.createHmac("sha256", secret).update(`${nonce}:${ts}:${requestJson}`).digest("hex"),
  });
  if (Buffer.byteLength(requestLine) >= 64 * 1024) {
    throw new Error("Client credential request exceeds the app control limit.");
  }
  const outcome = await requestJsonlSocket<
    { kind: "response"; response: z.infer<typeof responseSchema> } | { kind: "lost" }
  >({
    socketPath: path.join(directory, "mac-control.sock"),
    requestLine,
    timeoutMs: 15_000,
    signal,
    beforeSend: () => {
      signal?.throwIfAborted();
      assertCurrent?.();
    },
    maxResponseLineBytes: 64 * 1024 - 1,
    accept: (value) => ({ kind: "response", response: responseSchema.parse(value) }),
    onResponseLost: () => ({ kind: "lost" }),
    onTimeout: () => ({ kind: "lost" }),
  });
  signal?.throwIfAborted();
  if (!outcome) {
    return undefined;
  }
  // Dispatch is terminal: a lost response must never become an offline replay.
  if (outcome.kind === "lost") {
    throw new Error(
      "The client credential owner did not reply; retry through the matching OpenClaw app.",
    );
  }
  const { response } = outcome;
  if (!response.ok) {
    // This refusal occurs before the app acquires a root or executes an operation.
    if (response.error.code === "credential_root_unowned") {
      return undefined;
    }
    throw new Error(`Client credential owner refused the operation: ${response.error.message}`);
  }
  return response.result;
}
