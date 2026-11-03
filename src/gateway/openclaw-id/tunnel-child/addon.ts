// Loads the iroh Node binding (@openclaw/iroh-node, Buffer-based I/O). The
// tunnel child exits with TUNNEL_EXIT_UNAVAILABLE when it cannot load, so the
// Gateway reports the transport unavailable and keeps running.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Receiving half of a bidirectional stream. */
export type IrohRecvStream = {
  read(max: number): Promise<Buffer | null>;
  stop(code: number): Promise<void>;
};

/** Sending half of a bidirectional stream. */
export type IrohSendStream = {
  write(data: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  reset(code: number): Promise<void>;
};

/** An established, TLS-authenticated QUIC connection. */
export type IrohConnection = {
  remoteId(): string;
  acceptBi(): Promise<{ send: IrohSendStream; recv: IrohRecvStream }>;
  setMaxConcurrentBiStreams(n: number): void;
  close(code: number, reason: string): void;
  closed(): Promise<{ code?: number; reason: string; kind: string }>;
  pathKind(): string;
  rttMs(): number | null;
};

/** Connection state of one home relay. */
export type IrohHomeRelayStatus = {
  url: string;
  connected: boolean;
  lastError?: string | null;
  /** Set when the relay refused this endpoint's admission. */
  authDeniedReason?: string | null;
};

/** Follows home relay status: the first `next` resolves at once, later ones on change. */
type IrohHomeRelayWatcher = { next(): Promise<IrohHomeRelayStatus[] | null> };

/** A bound endpoint. */
export type IrohEndpoint = {
  id(): string;
  boundSockets(): string[];
  online(): Promise<void>;
  /** Missing from bindings built before relay status was exposed. */
  watchHomeRelay?(): Promise<IrohHomeRelayWatcher>;
  accept(): Promise<IrohConnection | null>;
  close(): Promise<void>;
};

/** The subset of @openclaw/iroh-node the tunnel child uses. */
export type IrohBinding = {
  bind(opts: {
    secretKey: Uint8Array;
    relayUrl?: string;
    alpns?: Uint8Array[];
    bindAddr?: string;
  }): Promise<IrohEndpoint>;
};

const PACKAGE_NAME = "@openclaw/iroh-node";
const SOURCE_CHECKOUT_PATH = path.join("crates", "openclaw-iroh-node", "index.js");

// Development checkouts carry the binding source in crates/; walk up to find it.
function findSourceCheckoutBinding(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, SOURCE_CHECKOUT_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Loads the binding: the installed package first, then a source checkout build. */
export function loadIrohBinding(): IrohBinding {
  const require = createRequire(import.meta.url);
  const errors: string[] = [];
  for (const specifier of [PACKAGE_NAME, findSourceCheckoutBinding()]) {
    if (!specifier) {
      continue;
    }
    try {
      // SAFETY: the iroh-node package exports this binding surface; IrohBinding lists only what the child calls.
      return require(specifier) as IrohBinding;
    } catch (error) {
      errors.push(
        `${specifier}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
      );
    }
  }
  throw new Error(`iroh binding unavailable (${errors.join("; ") || "not installed"})`);
}
