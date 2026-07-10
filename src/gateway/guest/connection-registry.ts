export interface GuestSocket {
  close(code: number, reason: string): void;
}

export type GuestConnectionBinding = {
  guestId: string;
  grantId: string;
  sessionKey: string;
  subscription: `session:${string}`;
  expiresAtMs: number;
};

type GuestConnection = GuestConnectionBinding & {
  socket: GuestSocket;
  expiryTimer: NodeJS.Timeout;
};

type GuestConnectionRegistryOptions = {
  now?: () => number;
  onExpired?: (binding: GuestConnectionBinding) => void;
};

export class GuestConnectionRegistry {
  private readonly byGrant = new Map<string, Set<GuestConnection>>();
  private readonly byGuest = new Map<string, GuestConnection>();
  private readonly now: () => number;
  private readonly onExpired: ((binding: GuestConnectionBinding) => void) | undefined;

  constructor(options: GuestConnectionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.onExpired = options.onExpired;
  }

  register(binding: GuestConnectionBinding, socket: GuestSocket): void {
    this.closeGuest(binding.guestId, 4400, "guest connection replaced");
    const connection: GuestConnection = {
      ...binding,
      socket,
      expiryTimer: this.createExpiryTimer(binding, socket),
    };
    const grantConnections = this.byGrant.get(binding.grantId) ?? new Set();
    grantConnections.add(connection);
    this.byGrant.set(binding.grantId, grantConnections);
    this.byGuest.set(binding.guestId, connection);
  }

  refreshDeadline(guestId: string, expiresAtMs: number): boolean {
    const current = this.byGuest.get(guestId);
    if (!current) {
      return false;
    }
    clearTimeout(current.expiryTimer);
    current.expiresAtMs = expiresAtMs;
    current.expiryTimer = this.createExpiryTimer(current, current.socket);
    return true;
  }

  unregister(guestId: string, socket?: GuestSocket): boolean {
    const current = this.byGuest.get(guestId);
    if (!current || (socket && current.socket !== socket)) {
      return false;
    }
    this.remove(current);
    return true;
  }

  closeGrant(grantId: string, code: number, reason: string): number {
    const connections = [...(this.byGrant.get(grantId) ?? [])];
    for (const connection of connections) {
      this.remove(connection);
      this.closeSocket(connection.socket, code, reason);
    }
    return connections.length;
  }

  closeSession(sessionKey: string, code: number, reason: string): number {
    const matches = [...this.byGuest.values()].filter(
      (connection) => connection.sessionKey === sessionKey,
    );
    for (const connection of matches) {
      this.remove(connection);
      this.closeSocket(connection.socket, code, reason);
    }
    return matches.length;
  }

  closeGuest(guestId: string, code: number, reason: string): boolean {
    const connection = this.byGuest.get(guestId);
    if (!connection) {
      return false;
    }
    this.remove(connection);
    this.closeSocket(connection.socket, code, reason);
    return true;
  }

  hasGuest(guestId: string): boolean {
    return this.byGuest.has(guestId);
  }

  countForGrant(grantId: string): number {
    return this.byGrant.get(grantId)?.size ?? 0;
  }

  countAll(): number {
    return this.byGuest.size;
  }

  closeAll(code = 1012, reason = "gateway restarting"): void {
    for (const connection of this.byGuest.values()) {
      this.remove(connection);
      this.closeSocket(connection.socket, code, reason);
    }
  }

  private createExpiryTimer(binding: GuestConnectionBinding, socket: GuestSocket): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        const current = this.byGuest.get(binding.guestId);
        if (!current || current.socket !== socket) {
          return;
        }
        this.remove(current);
        this.closeSocket(socket, 4401, "guest token expired");
        this.onExpired?.(binding);
      },
      Math.max(0, binding.expiresAtMs - this.now()),
    );
    timer.unref();
    return timer;
  }

  private remove(connection: GuestConnection): void {
    clearTimeout(connection.expiryTimer);
    this.byGuest.delete(connection.guestId);
    const grantConnections = this.byGrant.get(connection.grantId);
    grantConnections?.delete(connection);
    if (grantConnections?.size === 0) {
      this.byGrant.delete(connection.grantId);
    }
  }

  private closeSocket(socket: GuestSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Registry state is authoritative even when transport teardown throws.
    }
  }
}
