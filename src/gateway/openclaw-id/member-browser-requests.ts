// Display-only Inbox metadata. The existing claw writer owns persistence; no admission inputs.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isMemberBrowserRequestPayload,
  MEMBER_BROWSER_REQUEST_TTL_SECONDS,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityAccepted, AuthorityRefusal } from "./authority-result.js";
import type { MemberBrowserRequestState, StoredClaw } from "./claw-store.js";

// Cancellation never refunds a request slot; unseen terminal IDs have a separate bounded budget.
const REQUESTS_PER_WINDOW = 3;

/** Retire removed/expired notices and approvals through the existing metadata writer. */
export function retainBrowserRequests(
  record: StoredClaw,
  now: number,
  previous?: StoredClaw,
): StoredClaw {
  const requests = record.member_browser_requests;
  if (!requests) {
    return record;
  }
  let changed = false;
  const kept = Object.entries(requests).flatMap(([accountId, entry]) => {
    if (!Object.hasOwn(record.authority?.members ?? {}, accountId)) {
      changed = true;
      return [];
    }
    const recent = entry.recent.filter((receipt) => receipt.until > now);
    const terminal = (entry.terminal ?? []).filter((receipt) => receipt.until > now);
    const blockedUntil = entry.blockedUntil && entry.blockedUntil > now ? entry.blockedUntil : null;
    const priorMember = previous?.authority?.members[accountId];
    const addedDevice =
      priorMember &&
      record.authority?.members[accountId]?.peer_keys.some(
        (key) => !priorMember.peer_keys.includes(key),
      );
    const notice =
      entry.notice && entry.notice.expiresAt > now && !addedDevice ? entry.notice : null;
    if (!notice && recent.length === 0 && !terminal?.length && !blockedUntil) {
      changed = true;
      return [];
    }
    if (
      notice === entry.notice &&
      recent.length === entry.recent.length &&
      terminal.length === (entry.terminal?.length ?? 0) &&
      blockedUntil === (entry.blockedUntil ?? null)
    ) {
      return [[accountId, entry]];
    }
    changed = true;
    return [[accountId, { notice, recent, terminal, blockedUntil }]];
  });
  return changed ? { ...record, member_browser_requests: Object.fromEntries(kept) } : record;
}

/** Validate untrusted mail against current local membership and clock; never write signed state. */
function applyMemberBrowserRequest(
  current: StoredClaw | undefined,
  message: MailboxMessage,
  now: number,
): StoredClaw | AuthorityRefusal {
  const payload = message.payload;
  const refuse = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });
  if (!isMemberBrowserRequestPayload(payload) || message.to !== "gateway") {
    return refuse("malformed", "invalid member browser request");
  }
  if (!current?.authority || message.claw_id !== current.claw_id) {
    return refuse("wrong_claw", "member browser request is not for this claw");
  }
  const accountId = payload.member_account_id;
  if (
    accountId === current.discovery.owner_account_id ||
    !Object.hasOwn(current.authority.members, accountId)
  ) {
    return refuse("not_member", "browser notices require a current member");
  }
  if (
    !Number.isSafeInteger(message.received_at) ||
    message.received_at < 0 ||
    message.received_at > now ||
    payload.expires_at > message.received_at + MEMBER_BROWSER_REQUEST_TTL_SECONDS
  ) {
    return refuse("malformed", "invalid member browser request lifetime");
  }
  if (payload.expires_at <= now) {
    return refuse("expired", "member browser request expired");
  }
  const record = retainBrowserRequests(current, now);
  const previous = record.member_browser_requests?.[accountId];
  const recent = previous?.recent ?? [];
  const terminal = previous?.terminal ?? [];
  const blockedUntil = previous?.blockedUntil ?? null;
  let next: MemberBrowserRequestState;
  if (payload.action === "cancel") {
    if (previous?.notice?.requestId === payload.request_id) {
      next = { ...previous, notice: null };
    } else if (
      [...recent, ...terminal].some((receipt) => receipt.requestId === payload.request_id) ||
      (blockedUntil ?? 0) >= payload.expires_at
    ) {
      return record;
    } else if (terminal.length < REQUESTS_PER_WINDOW) {
      next = {
        notice: previous?.notice ?? null,
        recent,
        blockedUntil,
        terminal: [...terminal, { requestId: payload.request_id, until: payload.expires_at }],
      };
    } else {
      // Keep every accepted-ID receipt. Suppress new notices until overflow terminals expire.
      next = {
        notice: previous?.notice ?? null,
        recent,
        terminal,
        blockedUntil: Math.max(blockedUntil ?? 0, payload.expires_at),
      };
    }
  } else {
    if (recent.some((receipt) => receipt.requestId === payload.request_id)) {
      return previous?.notice?.requestId === payload.request_id
        ? record
        : refuse("replayed", "member browser request already retired");
    }
    if (terminal.some((receipt) => receipt.requestId === payload.request_id)) {
      return refuse("replayed", "member browser request already retired");
    }
    if (blockedUntil) {
      return refuse("rate_limited", "member browser terminal history is full");
    }
    if (recent.length >= REQUESTS_PER_WINDOW) {
      return refuse("rate_limited", "too many member browser requests");
    }
    next = {
      terminal,
      blockedUntil,
      notice: {
        requestId: payload.request_id,
        label: payload.label,
        location:
          typeof message.location_hint === "string"
            ? truncateUtf16Safe(message.location_hint, 256)
            : null,
        requestedAt: message.received_at,
        expiresAt: payload.expires_at,
      },
      recent: [
        ...recent,
        { requestId: payload.request_id, until: now + MEMBER_BROWSER_REQUEST_TTL_SECONDS },
      ],
    };
  }
  return {
    ...record,
    member_browser_requests: { ...record.member_browser_requests, [accountId]: next },
  };
}

/** Serialize display metadata through the same owner as membership, without submitting statements. */
export function createBrowserRequestHandler(owner: {
  serialize: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredClaw | undefined>;
  commit: (record: StoredClaw) => Promise<void>;
}) {
  return (message: MailboxMessage): Promise<AuthorityAccepted | AuthorityRefusal> =>
    owner.serialize(async () => {
      const current = await owner.load();
      const next = applyMemberBrowserRequest(current, message, Math.floor(Date.now() / 1000));
      if ("ok" in next) {
        return next;
      }
      if (next !== current) {
        await owner.commit(next);
      }
      return { ok: true, status: "applied", events: [] };
    });
}

/** Owner-only projection, using current canonical profiles rather than claimed sender identity. */
export function listMemberBrowserRequests(
  record: StoredClaw | undefined,
  members: Array<{ accountId: string; displayName: string | null; email: string | null }>,
  now: number,
) {
  return members.flatMap(({ accountId, displayName, email }) => {
    const notice = record?.member_browser_requests?.[accountId]?.notice;
    return notice &&
      notice.expiresAt > now &&
      Object.hasOwn(record?.authority?.members ?? {}, accountId)
      ? [{ ...notice, accountId, displayName, email }]
      : [];
  });
}
