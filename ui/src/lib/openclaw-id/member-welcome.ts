// A member's first arrival over the tunnel: they land on a new session, and the page asks who
// they are before it offers a composer. The Gateway names a member from their OpenClaw ID
// email until they choose a name, so a chosen name ends it. Name and photo stay in this
// Gateway's profile.
import { openClawIdEmailDisplayName } from "../../../../src/shared/openclaw-id-email-display-name.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { hasEmbedderTransport } from "../../app/remote-ingress.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { OpenClawIdStatusResult } from "./types.ts";

// The tunnel origin belongs to one claw, so the account alone scopes the answer.
const ANSWERED_KEY_PREFIX = "openclaw.openclawId.memberWelcome.v1:";
// Set while this browser's last connection was due no welcome, so its composer shows at once.
const SETTLED_KEY = "openclaw.openclawId.memberWelcome.settled.v1";

export type MemberWelcome = {
  accountId: string;
  email: string | null;
  /** How the member appears until they choose a name. */
  currentName: string | null;
  inviter: string | null;
  hostname: string | null;
};

export type MemberWelcomeState =
  | { kind: "none" }
  /** A tunnel connection whose status is not known yet: offer neither composer nor welcome. */
  | { kind: "pending" }
  | { kind: "due"; client: GatewayBrowserClient; self: AuthenticatedUser; welcome: MemberWelcome };

/** The welcome this connection is due: a member who has not chosen a name. */
export function memberWelcomeFor(status: OpenClawIdStatusResult): MemberWelcome | null {
  const member = status.connection;
  if (member?.kind !== "member") {
    return null;
  }
  const currentName = member.displayName?.trim() || null;
  if (currentName && currentName !== openClawIdEmailDisplayName(member.email)) {
    return null;
  }
  return {
    accountId: member.accountId,
    email: member.email,
    currentName,
    inviter: member.invitedBy?.name || member.invitedBy?.email || null,
    hostname: status.link.hostname ?? null,
  };
}

const owners = new WeakMap<ApplicationGateway, ReturnType<typeof createMemberWelcomeOwner>>();

/** The Gateway's one welcome owner; it reads the connection's status while it has a subscriber. */
export function memberWelcomeOwner(gateway: ApplicationGateway) {
  let owner = owners.get(gateway);
  if (!owner) {
    owner = createMemberWelcomeOwner(gateway);
    owners.set(gateway, owner);
  }
  return owner;
}

function createMemberWelcomeOwner(gateway: ApplicationGateway) {
  const storage = getSafeLocalStorage();
  const listeners = new Set<() => void>();
  let client: GatewayBrowserClient | null = null;
  let stop: (() => void) | undefined;
  let state: MemberWelcomeState =
    hasEmbedderTransport() && !storage?.getItem(SETTLED_KEY)
      ? { kind: "pending" }
      : { kind: "none" };
  const publish = (next: MemberWelcomeState) => {
    state = next;
    if (next.kind === "due") {
      storage?.removeItem(SETTLED_KEY);
    } else if (next.kind === "none") {
      storage?.setItem(SETTLED_KEY, "1");
    }
    listeners.forEach((listener) => listener());
  };
  const reconcile = () => {
    const snapshot = gateway.snapshot;
    const self = snapshot.phase === "connected" ? snapshot.selfUser : null;
    const next = self ? snapshot.client : null;
    if (!next || !self) {
      // The store reconnects on the same client: ask again then, unless a welcome is in progress.
      if (state.kind !== "due") {
        client = null;
      }
      return;
    }
    if (next === client) {
      return;
    }
    client = next;
    void next
      .request<OpenClawIdStatusResult>("openclawId.status", {})
      .then((status) => {
        if (client !== next) {
          return;
        }
        const welcome = memberWelcomeFor(status);
        publish(
          welcome && !storage?.getItem(ANSWERED_KEY_PREFIX + welcome.accountId)
            ? { kind: "due", client: next, self, welcome }
            : { kind: "none" },
        );
      })
      .catch(() => {
        // A connection that cannot read its status gets the ordinary composer.
        if (client === next) {
          state = { kind: "none" };
          listeners.forEach((listener) => listener());
        }
      });
  };
  return {
    get state() {
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = gateway.subscribe(reconcile);
        reconcile();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
    /** The member named themselves or skipped: remembered in this browser. */
    answer() {
      if (state.kind === "due") {
        storage?.setItem(ANSWERED_KEY_PREFIX + state.welcome.accountId, "1");
        publish({ kind: "none" });
      }
    },
  };
}

/**
 * Lands a member whose welcome is due on a new session, once, while they still sit on the
 * default landing: the main session is shared history, not a place to arrive.
 */
export function landDueMemberOnNewSession(
  gateway: ApplicationGateway,
  options: { isDefaultLanding: () => Promise<boolean>; openNewSession: () => void },
) {
  const owner = memberWelcomeOwner(gateway);
  let landed = false;
  const land = () => {
    if (landed || owner.state.kind !== "due") {
      return;
    }
    landed = true;
    void options
      .isDefaultLanding()
      .then((isDefault) => {
        if (isDefault && owner.state.kind === "due") {
          options.openNewSession();
        }
      })
      .catch(() => {
        /* An unresolved landing never redirects. */
      });
  };
  const stop = owner.subscribe(land);
  land();
  return stop;
}
