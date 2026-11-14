import type { UsersPrefsGetResult } from "../../../../packages/gateway-protocol/src/schema/users.ts";
// A member's first arrival over the tunnel: they land on a new session, and the page asks who
// they are before it offers a composer. The Gateway names a member from their OpenClaw ID
// email until they choose a name. A chosen name ends it, and so does their answer, which is
// kept with their Gateway profile so a name equal to the email's local part is not asked
// about again on another device. Name and photo stay in this Gateway's profile.
import { openClawIdEmailDisplayName } from "../../../../src/shared/openclaw-id-email-display-name.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { hasEmbedderTransport } from "../../app/remote-ingress.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { OpenClawIdStatusResult } from "./types.ts";

/** The profile preference that records the member's answer (named themselves or skipped). */
export const MEMBER_WELCOME_ANSWERED_PREFERENCE_KEY = "ui.openclawId.memberWelcomeAnswered";
// This browser's copy of the answer, for a profile whose preferences cannot be read or written.
// The tunnel origin belongs to one claw, so the account alone scopes it.
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

// Browser storage is a convenience here: a full or blocked store must not keep the welcome up.
function remember(write: (storage: Storage) => void): void {
  try {
    const storage = getSafeLocalStorage();
    if (storage) {
      write(storage);
    }
  } catch {
    // The in-memory state already holds the answer.
  }
}

async function answeredInProfile(client: GatewayBrowserClient): Promise<boolean> {
  try {
    const result = await client.request<UsersPrefsGetResult>("users.prefs.get", {
      keys: [MEMBER_WELCOME_ANSWERED_PREFERENCE_KEY],
    });
    return (
      result.status === "ok" && result.entries[MEMBER_WELCOME_ANSWERED_PREFERENCE_KEY] === true
    );
  } catch {
    return false;
  }
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
    remember((store) =>
      next.kind === "due" ? store.removeItem(SETTLED_KEY) : store.setItem(SETTLED_KEY, "1"),
    );
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
      .then(async (status) => {
        const welcome = memberWelcomeFor(status);
        const due =
          welcome !== null &&
          !storage?.getItem(ANSWERED_KEY_PREFIX + welcome.accountId) &&
          !(await answeredInProfile(next));
        if (client === next) {
          publish(due ? { kind: "due", client: next, self, welcome } : { kind: "none" });
        }
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
    /** The member named themselves or skipped: remembered with their profile and in this browser. */
    answer() {
      if (state.kind === "due") {
        const { client: answering, welcome } = state;
        publish({ kind: "none" });
        remember((store) => store.setItem(ANSWERED_KEY_PREFIX + welcome.accountId, "1"));
        void answering
          .request("users.prefs.set", {
            entries: { [MEMBER_WELCOME_ANSWERED_PREFERENCE_KEY]: true },
          })
          .catch(() => {
            /* This browser still remembers; another device asks once more. */
          });
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
