import { AsyncLocalStorage } from "node:async_hooks";
import { deserialize, serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  collectSynchronousErrors,
  materializeErrorStack,
} from "../../infra/error-graph-internal.js";
import { decodeNativeWorkerFailure } from "../../infra/worker-native-error.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { MAX_PENDING_BYTES, MAX_PENDING_MESSAGES } from "./ipc.js";
import { SpawnBrokerError } from "./protocol.js";
import type {
  BrokerResourceAttachment,
  BrokerResourceRequest,
  BrokerResourceResponse,
} from "./resource-protocol.js";
import { BrokerNativeResourceCloseError } from "./resource-protocol.js";

export type BrokerNativeResourceLease = {
  readonly attachment: BrokerResourceAttachment;
  setReferenced(this: void, referenced: boolean): void;
  receive(response: BrokerResourceResponse): void;
  ownerMessage(value: unknown): { sequence: number };
  close(): Promise<void>;
  release(): void;
  abandonUnattached(): void;
};
export type BrokerNativeResourceInput = { moduleUrl: string; input?: unknown; ownerPort: boolean };
export type BrokerNativeResourceCallbacks = {
  message(response: BrokerResourceResponse): void;
  failed(error: Error): void;
};
type Claim = {
  attachment: BrokerResourceAttachment;
  callbacks: BrokerNativeResourceCallbacks;
  inContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
  attached: Deferred;
  ready: boolean;
  created: boolean;
  closed: boolean;
  referenced: boolean;
  settling: boolean;
  failure?: Error;
  lastSequence: number;
  ownerSequence: number;
  ownerMessages: Map<number, Buffer>;
  pending?: { requestId: number; completion: Deferred };
};

/** Captured claims are part of SpawnBrokerHost; transport loss never retires their custody. */
export class BrokerResourceClaims {
  private readonly claims = new Map<number, Claim>();
  private bufferedBytes = 0;
  private bufferedMessages = 0;
  private closeSequence = 0;
  private failure: Error | undefined;
  private sealed = false;
  private sealPromise: Promise<void> | undefined;

  constructor(
    private readonly host: {
      transmit(
        request: Buffer | Exclude<BrokerResourceRequest, { type: "resource-attach" }>,
      ): Promise<void>;
      markReady(pid: number, generation: number): void;
      refreshReference(): void;
    },
  ) {}

  get size() {
    return this.claims.size;
  }
  get hasOpenClaims() {
    return [...this.claims.values()].some((claim) => !claim.closed);
  }
  get hasReferencedClaims() {
    return [...this.claims.values()].some(
      (claim) =>
        !claim.closed &&
        (claim.referenced ||
          !claim.ready ||
          !claim.created ||
          claim.settling ||
          claim.ownerMessages.size > 0),
    );
  }
  get admissionClosed() {
    return this.failure !== undefined || this.sealed;
  }

  capture(
    attachment: BrokerResourceAttachment,
    callbacks: BrokerNativeResourceCallbacks,
  ): BrokerNativeResourceLease {
    if (this.admissionClosed) {
      throw this.failure ?? new SpawnBrokerError("Native resource source is sealed");
    }
    // Validate and copy before admission; caller mutation cannot alter the captured factory input.
    const serializedAttachment = serialize(attachment);
    if (serializedAttachment.length > MAX_PENDING_BYTES) {
      throw new SpawnBrokerError("Native resource input exceeds IPC capacity");
    }
    const captured: BrokerResourceAttachment = deserialize(serializedAttachment);
    const claim: Claim = {
      attachment: captured,
      callbacks,
      inContext: AsyncLocalStorage.snapshot(),
      attached: createDeferredCore(),
      ready: false,
      created: false,
      closed: false,
      referenced: true,
      settling: false,
      lastSequence: 0,
      ownerSequence: 0,
      ownerMessages: new Map(),
    };
    void claim.attached.promise.catch(() => {});
    this.claims.set(captured.id, claim);
    this.host.refreshReference();
    const active = () => {
      if (this.claims.get(captured.id) !== claim) {
        throw new SpawnBrokerError("Native resource claim is released");
      }
      if (claim.failure) {
        throw claim.failure;
      }
    };
    return {
      attachment: captured,
      setReferenced: (referenced) => {
        if (claim.referenced !== referenced) {
          claim.referenced = referenced;
          this.host.refreshReference();
        }
      },
      receive: (response) => {
        if (response.id !== captured.id) {
          throw new SpawnBrokerError("Native resource response belongs to another claim");
        }
        this.receive(response);
      },
      ownerMessage: (value) => {
        active();
        if (claim.closed) {
          throw new SpawnBrokerError("Native resource is closed");
        }
        const sequence = claim.ownerSequence + 1;
        const serialized = serialize({ type: "resource-owner", id: captured.id, sequence, value });
        if (
          this.bufferedBytes + serialized.length > MAX_PENDING_BYTES ||
          this.bufferedMessages >= MAX_PENDING_MESSAGES
        ) {
          throw new SpawnBrokerError("Native resource owner delivery capacity exceeded");
        }
        claim.ownerSequence = sequence;
        claim.ownerMessages.set(sequence, serialized);
        this.bufferedBytes += serialized.length;
        this.bufferedMessages++;
        this.host.refreshReference();
        void (async () => {
          await claim.attached.promise;
          active();
          const pending = claim.ownerMessages.get(sequence);
          if (!claim.closed && pending) {
            await this.host.transmit(pending);
          }
        })().catch((cause: unknown) => {
          const error = toErrorObject(cause, "Native resource owner delivery failed");
          if (this.claims.get(captured.id) === claim && !claim.closed && !claim.failure) {
            claim.inContext(() => claim.callbacks.failed(error));
          }
        });
        return { sequence };
      },
      close: () => {
        if (claim.closed) {
          return Promise.resolve();
        }
        try {
          active();
        } catch (error) {
          return Promise.reject(toErrorObject(error, "Native resource is unavailable"));
        }
        if (claim.pending) {
          return claim.pending.completion.promise;
        }
        const requestId = --this.closeSequence;
        const completion = createDeferredCore();
        void completion.promise.catch(() => {});
        claim.pending = { requestId, completion };
        // A failed close still owes native settlement; only resource-closed clears it.
        claim.settling = true;
        this.host.refreshReference();
        void (async () => {
          await claim.attached.promise;
          active();
          if (!claim.closed && claim.pending?.requestId === requestId) {
            await this.host.transmit({ type: "resource-close", id: captured.id, requestId });
          }
        })().catch((error: unknown) => {
          if (claim.pending?.requestId === requestId) {
            claim.pending = undefined;
            completion.reject(toErrorObject(error, "Native resource close delivery failed"));
          }
        });
        return completion.promise;
      },
      release: () => {
        if (this.claims.get(captured.id) !== claim) {
          return;
        }
        if (!claim.closed) {
          throw new SpawnBrokerError("Native resource must close before release");
        }
        void this.host.transmit({ type: "resource-release", id: captured.id }).catch(() => {});
        this.remove(claim);
      },
      abandonUnattached: () => {
        if (this.claims.get(captured.id) !== claim) {
          return;
        }
        if (claim.ready || claim.created) {
          throw new SpawnBrokerError("Attached native resource cannot be abandoned");
        }
        // The caller must hold the constructor/sender's explicit no-dispatch receipt.
        const error = new SpawnBrokerError("Native resource was never dispatched");
        claim.attached.reject(error);
        claim.pending?.completion.reject(error);
        this.remove(claim);
      },
    };
  }

  receive(response: BrokerResourceResponse): void {
    const claim = this.claims.get(response.id);
    if (!claim || (claim.failure && response.type !== "resource-closed")) {
      return;
    }
    if (response.type === "resource-ready") {
      this.host.markReady(response.pid, response.generation);
      if (claim.ready) {
        return;
      }
      claim.ready = true;
      claim.attached.resolve();
    } else if (response.type === "resource-created") {
      if (claim.created) {
        return;
      }
      claim.created = true;
    } else if (
      response.type === "resource-owner-received" ||
      response.type === "resource-owner-rejected"
    ) {
      const pending = claim.ownerMessages.get(response.sequence);
      if (pending) {
        claim.ownerMessages.delete(response.sequence);
        this.bufferedBytes -= pending.length;
        this.bufferedMessages--;
        if (response.type === "resource-owner-rejected") {
          const error = toErrorObject(
            decodeNativeWorkerFailure(response.error),
            "Native resource owner callback failed",
          );
          claim.settling = true;
          this.host.refreshReference();
          claim.inContext(() => claim.callbacks.failed(error));
        }
        this.host.refreshReference();
      }
      return;
    } else if (response.type === "resource-owner") {
      // Both transports carry every owner event in order; only their duplicate copies can lag.
      if (response.sequence <= claim.lastSequence) {
        return;
      }
      claim.lastSequence = response.sequence;
      claim.inContext(() => claim.callbacks.message(response));
      return;
    } else if (response.type === "resource-closed") {
      if (claim.closed) {
        return;
      }
      claim.closed = true;
      this.clearOwnerMessages(claim);
      claim.pending?.completion.resolve();
      claim.pending = undefined;
    } else if (response.type === "resource-close-error") {
      if (claim.pending?.requestId === response.requestId) {
        const pending = claim.pending;
        claim.pending = undefined;
        pending.completion.reject(
          response.resourceError
            ? new BrokerNativeResourceCloseError(response.error)
            : toErrorObject(
                decodeNativeWorkerFailure(response.error),
                "Native resource cleanup failed",
              ),
        );
      }
    } else if (response.type === "resource-failed") {
      // A delayed factory/operation failure cannot settle the separate native close obligation.
      const error = toErrorObject(
        decodeNativeWorkerFailure(response.error),
        "Native resource failed",
      );
      claim.settling = true;
      this.host.refreshReference();
      claim.inContext(() => claim.callbacks.failed(error));
      return;
    }
    this.host.refreshReference();
    claim.inContext(() => claim.callbacks.message(response));
  }

  /** Reject new claims without settling retained native resources. */
  closeAdmission(): void {
    this.sealed = true;
  }

  seal(): Promise<void> {
    if (this.sealPromise) {
      return this.sealPromise;
    }
    this.closeAdmission();
    this.sealPromise = this.host.transmit({ type: "resource-seal" }).then(
      () => {
        for (const claim of this.claims.values()) {
          claim.attached.resolve();
        }
      },
      (error: unknown) => {
        materializeErrorStack(error);
        throw error;
      },
    );
    return this.sealPromise;
  }

  /** The broker reported refused initialization and its process and pipes have joined. */
  closeBeforeStartup(): void {
    for (const claim of this.claims.values()) {
      this.receive({ type: "resource-closed", id: claim.attachment.id, requestId: 0 });
    }
  }

  fail(error: Error): void {
    materializeErrorStack(error);
    this.failure ??= error;
    const failed = [...this.claims.values()].filter((claim) => this.rejectClaim(claim, error));
    const callbackErrors = collectSynchronousErrors(failed, (claim) =>
      claim.inContext(() => claim.callbacks.failed(error)),
    );
    if (callbackErrors.length) {
      throw new AggregateError(callbackErrors, "Native resource failure callback failed");
    }
  }

  private rejectClaim(claim: Claim, error: Error): boolean {
    if (claim.failure || claim.closed) {
      return false;
    }
    claim.failure = error;
    claim.settling = true;
    this.host.refreshReference();
    claim.attached.reject(error);
    claim.pending?.completion.reject(error);
    claim.pending = undefined;
    return true;
  }

  private clearOwnerMessages(claim: Claim): void {
    for (const pending of claim.ownerMessages.values()) {
      this.bufferedBytes -= pending.length;
      this.bufferedMessages--;
    }
    claim.ownerMessages.clear();
  }

  private remove(claim: Claim): void {
    this.clearOwnerMessages(claim);
    this.claims.delete(claim.attachment.id);
    this.host.refreshReference();
  }
}
