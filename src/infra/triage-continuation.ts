// Private live continuations across the installed CLI, never serialized execution authority.
import { realpathSync } from "node:fs";
import { z } from "zod";
import type { TriageFailureContext } from "../commands/triage-prompt.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  UPDATE_RUN_ID_ENV,
} from "./update-control-plane-sentinel.js";
import {
  createManagedHandoffLeaseStore,
  prepareManagedHandoffLeaseStore,
  triageFailureSchema as failureSchema,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
  type UpdateRequesterAuthority,
} from "./update-requester-authority.js";

// Reuse the handoff admission/shutdown budget; cleanup loss must return to the caller.
const TRIAGE_HANDOFF_GRACE_MS = 30_000;

const continuationSchema = z.strictObject({
  type: z.literal("triage"),
  version: z.literal(2),
  failure: failureSchema,
  installRoot: z.string().min(1).max(4096),
  owner: z.string().min(1).max(4096),
  requester: z
    .strictObject({
      channel: z.string().max(4096).optional(),
      accountId: z.string().max(4096).optional(),
      senderId: z.string().max(4096).optional(),
      authorizationSource: z.string().max(4096).optional(),
    })
    .optional(),
});

function ownsChildLease(root: string, action: "update" | "triage"): ManagedHandoffLease | null {
  const store = createManagedHandoffLeaseStore();
  const result = store.read(root);
  return result.kind === "current" &&
    result.lease.action.kind === action &&
    result.lease.helper.pid === process.ppid &&
    process.connected &&
    store.owns(result.lease, "executor")
    ? result.lease
    : null;
}

async function exchangeWithParent(message: object, signal?: AbortSignal): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.removeListener("message", received);
      process.removeListener("disconnect", disconnected);
      signal?.removeEventListener("abort", aborted);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const received = (value: unknown) => finish(null, value);
    const disconnected = () => finish(new Error("automatic triage owner disconnected"));
    const aborted = () => finish(new Error("automatic triage admission cancelled"));
    const timer = setTimeout(
      () => finish(new Error("automatic triage admission timed out")),
      TRIAGE_HANDOFF_GRACE_MS,
    );
    process.once("message", received).once("disconnect", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    if (!process.connected || !process.send) {
      disconnected();
      return;
    }
    process.send(message, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

export async function acceptTriageContinuation(): Promise<
  | {
      failure: TriageFailureContext;
      signal: AbortSignal;
      assertCurrent: () => void;
      finish: (cleanup: "closed" | "uncertain") => Promise<void>;
    }
  | undefined
> {
  if (process.env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return undefined;
  }
  if (!process.send || !process.connected) {
    throw new Error(
      "automatic triage requires its original connected owner; run openclaw triage manually",
    );
  }
  const store = await prepareManagedHandoffLeaseStore();
  const controller = new AbortController();
  const parent = store.processIdentity(process.ppid);
  let lease: ManagedHandoffLease | undefined;
  let requesterAuthority: UpdateRequesterAuthority | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let shutdown: ReturnType<typeof setTimeout> | undefined;
  const armShutdown = () => {
    if (!lease || shutdown) {
      return;
    }
    shutdown = setTimeout(() => {
      try {
        store.settle(lease!, "uncertain");
      } finally {
        process.kill(process.pid, "SIGKILL");
      }
    }, TRIAGE_HANDOFF_GRACE_MS);
    shutdown.unref();
  };
  const cancel = (reason?: unknown) => {
    if (disposed || controller.signal.aborted) {
      return;
    }
    armShutdown();
    try {
      if (lease) {
        store.settle(lease, "closing");
      }
    } catch {
      // Revocation failure retains the claim; local cancellation must still drain resources.
    }
    controller.abort(
      reason instanceof Error
        ? reason
        : new Error("automatic triage cancelled: live owner or claim lost"),
    );
    if (lease?.action.kind === "triage" && lease.action.lifetime.kind === "native") {
      try {
        store.stopNative(lease, true);
      } catch {
        /* Native helper also owns scope closure. */
      }
    }
  };
  const onMessage = (message: unknown) => {
    if (
      z.strictObject({ type: z.literal("triage-cancel"), version: z.literal(2) }).safeParse(message)
        .success
    ) {
      cancel();
    }
  };
  const checkCurrent = () => {
    try {
      if (requesterAuthority && !requesterAuthority.isCurrent()) {
        throw new UpdateRequesterRevokedError();
      }
      if (
        disposed ||
        !lease ||
        !process.connected ||
        process.ppid !== parent.pid ||
        !store.owns(lease, "executor") ||
        (lease.action.kind === "triage" &&
          lease.action.lifetime.kind === "native" &&
          (lease.action.lifetime.placement.kind !== "attached" ||
            !store.isInNativeScope(lease.action.lifetime)))
      ) {
        cancel();
      }
    } catch (error) {
      cancel(error);
    }
  };
  const assertCurrent = () => {
    checkCurrent();
    if (disposed) {
      throw new Error("automatic triage continuation is closed");
    }
    controller.signal.throwIfAborted();
  };
  const finish = async (cleanup: "closed" | "uncertain") => {
    if (disposed) {
      return;
    }
    armShutdown();
    try {
      if (lease) {
        store.settle(lease, cleanup);
      }
    } finally {
      disposed = true;
      clearInterval(watch);
      process.removeListener("disconnect", cancel).removeListener("message", onMessage);
      controller.abort(new Error("automatic triage continuation closed"));
      if (process.connected) {
        process.disconnect?.();
      }
    }
  };
  process.once("disconnect", cancel);
  try {
    const { failure, installRoot, owner, requester } = continuationSchema.parse(
      await exchangeWithParent({ type: "triage-ready", version: 2 }),
    );
    const admitted = ownsChildLease(installRoot, "triage");
    if (
      !admitted ||
      admitted.owner !== owner ||
      admitted.action.kind !== "triage" ||
      admitted.action.phase !== "running" ||
      realpathSync(installRoot) !== installRoot ||
      failure.installationRoot !== installRoot ||
      JSON.stringify(admitted.helper) !== JSON.stringify(parent)
    ) {
      throw new Error("automatic triage lost its live root/generation claim");
    }
    lease = admitted;
    if (admitted.action.lifetime.kind === "native") {
      const life = admitted.action.lifetime;
      if (life.placement.kind !== "attached" || !store.isInNativeScope(life)) {
        throw new Error("automatic triage executor is outside its native scope");
      }
    }
    requesterAuthority = requester
      ? await createManagedUpdateRequesterAuthority(requester)
      : undefined;
    process.on("message", onMessage);
    watch = setInterval(checkCurrent, 250);
    assertCurrent();
    delete process.env.OPENCLAW_UPDATE_RUN_HANDOFF;
    delete process.env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV];
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    delete process.env[UPDATE_RUN_ID_ENV];
    return { failure, signal: controller.signal, assertCurrent, finish };
  } catch (error) {
    cancel();
    await finish("uncertain");
    throw error;
  }
}
