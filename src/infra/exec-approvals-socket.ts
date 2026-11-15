import { randomBytes } from "node:crypto";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runClientCredentialOperationAsync } from "./client-credential-async.js";
import type { ClientSocketRecord } from "./client-credential-store.js";
import { resolveExecApprovalsSocketPath } from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";

type SocketOperationOptions = { signal?: AbortSignal; assertCurrent?: () => void };

export async function readExecApprovalsSocket(
  env: NodeJS.ProcessEnv = process.env,
  options?: SocketOperationOptions,
): Promise<ClientSocketRecord | null> {
  const result = await runClientCredentialOperationAsync(env, { kind: "socket.read" }, options);
  if (result.kind !== "socket") {
    throw new Error("Client credential owner returned an invalid socket result.");
  }
  return result.socket;
}

/** Local credential changes never mutate the shared approval policy or its hash. */
export async function ensureExecApprovalsSocket(
  env: NodeJS.ProcessEnv = process.env,
  options?: SocketOperationOptions,
  requested?: ExecApprovalsFile["socket"],
): Promise<ClientSocketRecord> {
  const result = await runClientCredentialOperationAsync(
    env,
    {
      kind: "socket.ensure",
      fallback: {
        socket_key: "current",
        socket_path: resolveExecApprovalsSocketPath(env),
        socket_token: randomBytes(24).toString("base64url"),
        updated_at_ms: Date.now(),
      },
      requested,
    },
    options,
  );
  if (result.kind !== "socket" || !result.socket) {
    throw new Error("Client credential owner returned an invalid socket result.");
  }
  return result.socket;
}

export async function attachExecApprovalsSocket(
  snapshot: ExecApprovalsSnapshot,
  context: Pick<
    OpenClawStateWorkerContext,
    "environment" | "initializationEnvironment" | "admission"
  >,
  assertCurrent?: () => void,
  requested?: ExecApprovalsFile["socket"],
): Promise<ExecApprovalsSnapshot> {
  const socket = await ensureExecApprovalsSocket(
    context.initializationEnvironment ?? context.environment,
    {
      assertCurrent: () => {
        context.admission.assertCurrent();
        assertCurrent?.();
      },
    },
    requested,
  );
  return {
    ...snapshot,
    file: {
      ...snapshot.file,
      socket: {
        ...snapshot.file.socket,
        path: socket.socket_path ?? undefined,
        token: socket.socket_token ?? undefined,
      },
    },
  };
}
