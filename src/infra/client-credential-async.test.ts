import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareStartupClientCredentials } from "../commands/startup-client-credentials.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { runClientCredentialOperationAsync } from "./client-credential-async.js";
import { requestClientCredentialsFromApp } from "./client-credential-ipc.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  runClientCredentialOperation,
  type ClientCredentialOperation,
} from "./client-credential-store.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import type { ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import { attachExecApprovalsSocket } from "./exec-approvals-socket.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const mac = it.runIf(process.platform === "darwin");
const identityRead = { kind: "identity.read", identity_key: "primary" } as const;
const tokenKey = (device_id: string) => ({ device_id, role: "operator" });
function replaceToken(
  deviceId: string,
  token: string,
): Extract<ClientCredentialOperation, { kind: "token.replace" }> {
  const key = tokenKey(deviceId);
  return {
    kind: "token.replace",
    key,
    token: { ...key, token, scopes_json: "[]", updated_at_ms: 1 },
  };
}

function fixture() {
  const root = dirs.make("cc-");
  return { root, env: { HOME: root, OPENCLAW_STATE_DIR: root } };
}

async function holdStore(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
    process.stdout.write('ready');
    process.stdin.once('data', () => { db.close(); process.exit(0); });
  `,
      resolveClientCredentialStorePath(env),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await once(child.stdout!, "data");
  return child;
}

async function releaseStore(child: ChildProcess) {
  const exited = once(child, "exit");
  child.stdin!.end("release");
  await exited;
}

async function listenApp(
  home: string,
  handle: (
    request: {
      operation: string;
      credentialRoot: string;
      credentialOperation: ClientCredentialOperation;
    },
    socket: net.Socket,
  ) => void,
  profile?: string,
): Promise<net.Server> {
  const control = path.join(home, profile ? `.openclaw-${profile}` : ".openclaw");
  fs.mkdirSync(control, { mode: 0o700 });
  const secret = "synthetic-app-control-key";
  fs.writeFileSync(path.join(control, "mac-control.token"), secret, { mode: 0o600 });
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let line = "";
    socket.on("data", (chunk) => {
      line += chunk.toString();
      if (!line.includes("\n")) {
        return;
      }
      const envelope = JSON.parse(line);
      expect(envelope.hmac).toBe(
        crypto
          .createHmac("sha256", secret)
          .update(`${envelope.nonce}:${envelope.ts}:${envelope.requestJson}`)
          .digest("hex"),
      );
      handle(JSON.parse(envelope.requestJson), socket);
    });
  });
  server.listen(path.join(control, "mac-control.sock"));
  await once(server, "listening");
  return server;
}

it("serializes first creation, preserves the winner and cancels queued writes without shared state", async () => {
  const { root, env } = fixture();
  const first = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(123), 456);
  const second = {
    ...storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(789), 999),
    private_key_pem: "competing-candidate",
  };
  const controller = new AbortController();
  const one = runClientCredentialOperationAsync(env, { kind: "identity.create", identity: first });
  const two = runClientCredentialOperationAsync(env, { kind: "identity.create", identity: second });
  const cancelled = runClientCredentialOperationAsync(
    env,
    replaceToken(first.device_id, "synthetic"),
    { signal: controller.signal },
  ).catch((error: unknown) => error);
  controller.abort();
  expect(await one).toEqual({ kind: "identity", identity: first });
  expect(await two).toEqual({ kind: "identity", identity: first });
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  expect(
    await runClientCredentialOperationAsync(env, {
      kind: "token.read",
      key: tokenKey(first.device_id),
    }),
  ).toEqual({ kind: "token", token: null });
  expect(fs.existsSync(path.join(root, "state"))).toBe(false);
});

it("waits for a short-lived offline owner when no app endpoint exists", async () => {
  const { env } = fixture();
  const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity());
  await runClientCredentialOperationAsync(env, { kind: "identity.create", identity });
  const child = await holdStore(env);
  let released: Promise<void> | undefined;
  const timer = setTimeout(() => {
    released = releaseStore(child);
  }, 500);
  try {
    expect(await runClientCredentialOperationAsync(env, identityRead)).toEqual({
      kind: "identity",
      identity,
    });
  } finally {
    clearTimeout(timer);
    await (released ?? releaseStore(child));
  }
});

mac("routes approval socket ensure through the captured named-profile app", async () => {
  const { root, env: homeEnv } = fixture();
  const env = { ...homeEnv, OPENCLAW_PROFILE: "p" };
  const context = captureOpenClawStateWorkerContext({ env });
  const snapshot: ExecApprovalsSnapshot = {
    path: path.join(root, "exec-approvals.json"),
    exists: true,
    raw: "synthetic-policy",
    hash: "synthetic-policy-hash",
    file: { version: 1, defaults: { security: "deny" } },
  };
  const appSocket = {
    socket_key: "current" as const,
    socket_path: path.join(root, "approvals.sock"),
    socket_token: "synthetic-profile-socket-token",
    updated_at_ms: 1,
  };
  const requests: unknown[] = [];
  await using _ = await listenApp(
    root,
    (request, socket) => {
      requests.push(request);
      expect(request.credentialRoot).toBe(root);
      expect(request.credentialOperation.kind).toBe("socket.ensure");
      socket.end(
        `${JSON.stringify({ ok: true, result: { kind: "socket", socket: appSocket } })}\n`,
      );
    },
    "p",
  );
  await withEnvAsync({ HOME: root, USERPROFILE: root, OPENCLAW_PROFILE: "default" }, async () => {
    expect(await attachExecApprovalsSocket(snapshot, context)).toEqual({
      ...snapshot,
      file: {
        ...snapshot.file,
        socket: { path: appSocket.socket_path, token: appSocket.socket_token },
      },
    });
    expect(requests).toHaveLength(1);
    expect(fs.existsSync(resolveClientCredentialStorePath(env))).toBe(false);
  });
});

mac(
  "uses authenticated app custody and never replays a dispatched request after reply loss",
  async () => {
    const { root, env } = fixture();
    const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity());
    runClientCredentialOperation(env, { kind: "identity.create", identity });
    let loseReply = false;
    let release: (() => void) | undefined;
    const requests: unknown[] = [];
    await using _ = await listenApp(root, (request, socket) => {
      requests.push(request);
      expect(request.credentialRoot).toBe(root);
      expect(request.operation).toBe("client.credentials");
      if (loseReply) {
        release?.();
        socket.destroy();
      } else {
        socket.end(`${JSON.stringify({ ok: true, result: { kind: "identity", identity } })}\n`);
      }
    });
    const child = await holdStore(env);
    let released: Promise<void> | undefined;
    try {
      await prepareStartupClientCredentials({ env });
      expect(await runClientCredentialOperationAsync(env, identityRead)).toEqual({
        kind: "identity",
        identity,
      });
      loseReply = true;
      release = () => {
        released = releaseStore(child);
      };
      await expect(
        runClientCredentialOperationAsync(env, replaceToken(identity.device_id, "must-not-replay")),
      ).rejects.toThrow("did not reply");
      await released;
      expect(requests).toHaveLength(3);
      expect(
        runClientCredentialOperation(env, {
          kind: "token.read",
          key: tokenKey(identity.device_id),
        }),
      ).toEqual({ kind: "token", token: null });
    } finally {
      if (!released) {
        await releaseStore(child);
      }
    }
  },
);

mac.each([
  { code: "credential_root_unowned", message: "synthetic refusal", fallback: true },
  // Released apps without the credential route refuse it before dispatch.
  { code: "invalid_request", message: "Unknown control operation.", fallback: true },
  { code: "invalid_request", message: "synthetic refusal", fallback: false },
])(
  "uses offline custom-root custody only for predispatch $code refusal: $message",
  async ({ code, message, fallback }) => {
    const { root, env: homeEnv } = fixture();
    const customRoot = path.join(root, "unrelated-client");
    const env = { ...homeEnv, OPENCLAW_STATE_DIR: customRoot };
    const operation = replaceToken("custom-root-device", "synthetic-custom-root-token");
    const { token } = operation;
    await using _ = await listenApp(root, (request, socket) => {
      expect(request.credentialRoot).toBe(customRoot);
      socket.end(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    });
    const result = runClientCredentialOperationAsync(env, operation);
    if (fallback) {
      await expect(result).resolves.toEqual({ kind: "changed", changed: true });
      expect(runClientCredentialOperation(env, { kind: "token.read", key: token })).toEqual({
        kind: "token",
        token,
      });
    } else {
      await expect(result).rejects.toThrow("synthetic refusal");
      expect(fs.existsSync(resolveClientCredentialStorePath(env))).toBe(false);
    }
  },
);

mac("rejects unsafe app credentials before dispatch", async () => {
  const { root, env } = fixture();
  const directory = path.join(root, ".openclaw");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "mac-control.token"), "synthetic", { mode: 0o644 });
  await expect(requestClientCredentialsFromApp(env, { kind: "socket.read" })).rejects.toThrow(
    "unsafe",
  );
});
