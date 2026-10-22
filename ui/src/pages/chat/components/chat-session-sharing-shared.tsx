import { action, createMemo, createOptimistic, createSignal, onSettled, Show } from "solid-js";
import { SESSION_VISIBILITY_VALUES } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
} from "../../../api/types.ts";
import type { PersonActivityRouting } from "../../../components/person-activity-link.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerSessionPeopleEnglish } from "../../../i18n/locales/en-session-people.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";

registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerSessionPeopleEnglish);

export type ChatSessionSharingOutcome =
  | { status: "success" }
  | { status: "unchanged" | "unavailable" | "cancelled" | "stale" }
  | { status: "failed"; error: string };

// Legacy parents may still discard the result; only confirmed success closes a surface.
type ChatSessionSharingAction =
  | void
  | ChatSessionSharingOutcome
  | Promise<void | ChatSessionSharingOutcome>;

export type ChatSessionSharingState = {
  loading: boolean;
  /** Completes after the pane publishes or retires its admitted membership read. */
  read?: Promise<void>;
  result?: SessionMembersListEvidenceResult;
  publicUrl?: string;
  error?: string;
};

export type ChatSessionSharingProps = {
  session: GatewaySessionRow | undefined;
  operationSignal?: AbortSignal;
  state: ChatSessionSharingState | undefined;
  allowedVisibilities?: readonly SessionVisibility[];
  membersAvailable?: boolean;
  openDisabledReason?: string;
  visibilityDisabledReason?: string;
  memberAddDisabledReason?: string;
  memberRemoveDisabledReason?: string;
  publicShareDisabledReason?: string;
  onPublicShareChange?: (enabled: boolean) => ChatSessionSharingAction;
  onCopyPublicLink?: () => ChatSessionSharingAction;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  showOwner?: boolean;
  onOpen: () => void;
  onVisibilityChange: (visibility: SessionVisibility) => ChatSessionSharingAction;
  onMemberChange: (identityId: string, member: boolean) => ChatSessionSharingAction;
};

export type PreparedChatSessionSharing = Omit<
  ChatSessionSharingProps,
  "session" | "onVisibilityChange" | "onMemberChange" | "onPublicShareChange" | "onCopyPublicLink"
> & {
  session: GatewaySessionRow;
  onVisibilityChange: (visibility: SessionVisibility) => Promise<ChatSessionSharingOutcome>;
  onMemberChange: (identityId: string, member: boolean) => Promise<ChatSessionSharingOutcome>;
  onPublicShareChange: (enabled: boolean) => Promise<ChatSessionSharingOutcome>;
  onCopyPublicLink: () => Promise<ChatSessionSharingOutcome>;
};

export const VISIBILITY_LABEL_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.shared",
  "read-only": "chat.sessionSharing.readOnly",
  suggest: "chat.sessionSharing.suggest",
  draft: "chat.sessionSharing.draft",
};

function selectChatSessionSharingItem(
  props: ChatSessionSharingProps,
  value: string | undefined,
): ChatSessionSharingAction {
  if (!props.session || !canManageChatSessionSharing(props.session) || props.state?.loading) {
    return { status: "unavailable" };
  }
  if (value?.startsWith("public:")) {
    if (!props.state?.result) {
      return { status: "unavailable" };
    }
    if (value === "public:copy" && props.state.result.publicShare) {
      return props.onCopyPublicLink?.();
    } else if (
      !props.publicShareDisabledReason &&
      (value === "public:enable" || value === "public:disable")
    ) {
      return props.onPublicShareChange?.(value === "public:enable");
    }
    return;
  }
  const members = new Set(props.state?.result?.members.map((member) => member.identityId) ?? []);
  if (value?.startsWith("visibility:")) {
    const visibility = SESSION_VISIBILITY_VALUES.find((option) => value === `visibility:${option}`);
    if (
      visibility &&
      (
        props.state?.result?.allowedVisibilities ??
        props.allowedVisibilities ?? [props.session.visibility ?? "shared"]
      ).includes(visibility) &&
      !props.visibilityDisabledReason &&
      visibility !== (props.session?.visibility ?? "shared")
    ) {
      return props.onVisibilityChange(visibility);
    }
    return;
  }
  if (!value?.startsWith("member:")) {
    return;
  }
  const identityId = value.slice("member:".length);
  if (identityId === props.state?.result?.owner?.id) {
    return { status: "unavailable" };
  }
  const member = !members.has(identityId);
  const disabledReason = member ? props.memberAddDisabledReason : props.memberRemoveDisabledReason;
  if (!disabledReason) {
    return props.onMemberChange(identityId, member);
  }
}

/** Presents admitted work; the pane still owns reads, writes, and their outcomes. */
export function createChatSessionSharingPresentation(
  source: () => ChatSessionSharingProps | null | undefined,
) {
  const scope = createMemo(
    () => {
      const props = source();
      return {
        key: props?.session?.key,
        sessionId: props?.session?.sessionId,
        signal: props?.operationSignal,
      };
    },
    {
      equals: (previous, next) =>
        previous.key === next.key &&
        previous.sessionId === next.sessionId &&
        previous.signal === next.signal,
    },
  );
  const read = createMemo(() => source()?.state?.read);
  const [saving, setSaving] = createOptimistic<ReturnType<typeof scope> | null>(null);
  const [error, setError] = createSignal<string | undefined>(() => {
    scope();
    return undefined;
  });
  const disposed = Promise.withResolvers<void>();
  onSettled(() => () => disposed.resolve());

  const present = action(function* (
    target: ReturnType<typeof scope>,
    pending: Promise<void | ChatSessionSharingOutcome>,
  ): Generator<
    Promise<void | ChatSessionSharingOutcome>,
    void | ChatSessionSharingOutcome,
    void | ChatSessionSharingOutcome
  > {
    const retired = Promise.withResolvers<void>();
    const stop = target.signal
      ? listen(target.signal, "abort", () => retired.resolve(), { once: true })
      : undefined;
    if (target.signal?.aborted) {
      retired.resolve();
    } else if (scope() === target) {
      setSaving(target);
    }
    try {
      return yield Promise.race([pending, retired.promise, disposed.promise]);
    } finally {
      stop?.();
    }
  });

  async function select(value: string) {
    const props = source();
    if (!props) {
      return;
    }
    const target = scope();
    setError(undefined);
    try {
      // Admission and its synchronous publication precede the presentation transaction.
      const pending = selectChatSessionSharingItem(props, value);
      if (!(pending instanceof Promise)) {
        return pending;
      }
      await Promise.resolve();
      return await present(target, pending);
    } catch (cause) {
      if (target.signal?.aborted || scope() !== target) {
        return;
      }
      const message = formatUiError(cause);
      setError(message);
      return { status: "failed", error: message } satisfies ChatSessionSharingOutcome;
    }
  }

  return { read, scope, select, error, busy: () => saving() === scope() };
}

export function canManageChatSessionSharing(
  session: Pick<GatewaySessionRow, "sharingRole">,
): boolean {
  return session.sharingRole === "admin" || session.sharingRole === "owner";
}

export function ChatSessionSharingModeIcon(props: {
  visibility: SessionVisibility;
  external?: boolean;
}) {
  return (
    <Icon
      class={props.visibility === "draft" ? "chat-pane__sharing-draft-glyph" : undefined}
      name={
        props.visibility === "draft"
          ? "messageCircle"
          : props.visibility === "shared"
            ? "users"
            : props.visibility === "suggest"
              ? "messageSquarePlus"
              : props.external
                ? "eye"
                : "messageSquare"
      }
    />
  );
}

export function ChatSessionPublicIndicator(
  props: Pick<ChatSessionSharingProps, "state"> & { mobile?: boolean },
) {
  return (
    <Show when={props.state?.result?.publicShare}>
      <span
        class={[
          "chat-pane__public-share-indicator",
          { "chat-pane__public-share-indicator--mobile": props.mobile },
        ]}
        role="status"
        aria-label={t("chat.sessionSharing.worldReadable")}
        title={t("chat.sessionSharing.worldReadable")}
      >
        <Show when={!props.mobile}>
          <span aria-hidden="true">
            <Icon name="globe" />
          </span>
        </Show>
        <span>{t("chat.sessionSharing.publicIndicator")}</span>
      </span>
    </Show>
  );
}

export const CHAT_SESSION_SHARING_DESCRIPTION_KEYS: Record<SessionVisibility, string> = {
  shared: "chat.sessionSharing.sharedDescription",
  "read-only": "chat.sessionSharing.readOnlyDescription",
  suggest: "chat.sessionSharing.suggestDescription",
  draft: "chat.sessionSharing.draftDescription",
};

export function chatSessionMembershipLabel(owner: boolean, member: boolean) {
  return t(
    owner
      ? "chat.sessionSharing.owner"
      : member
        ? "chat.sessionSharing.member"
        : "chat.sessionSharing.visitor",
  );
}

export function projectChatSessionSharingRoster(props: ChatSessionSharingProps) {
  const result = props.state?.result;
  const creator = result?.owner;
  const members = new Set(result?.members.map((member) => member.identityId));
  const others = (result?.identities ?? [])
    .filter((person) => person.id !== creator?.id)
    .toSorted((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
  // Membership is not effective permission. The Gateway does not yet project that fact.
  return (creator ? [creator, ...others] : others).map((identity) => {
    const fixed = identity.id === creator?.id;
    const selected = fixed || members.has(identity.id);
    return {
      identity,
      fixed,
      selected,
      membershipLabel: chatSessionMembershipLabel(fixed, selected),
      disabledReason: fixed
        ? t("chat.sessionSharing.owner")
        : props.state?.loading
          ? t("common.loading")
          : selected
            ? props.memberRemoveDisabledReason
            : props.memberAddDisabledReason,
    };
  });
}
