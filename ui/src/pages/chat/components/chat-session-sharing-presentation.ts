import { action, createMemo, createOptimistic, createSignal, onSettled } from "solid-js";
import { SESSION_VISIBILITY_VALUES } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing-constants.js";
import type { SessionMemberPermissionLevel } from "../../../../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { SessionMembersListEvidenceResult } from "../../../api/types.ts";
import { registerChatSessionSharingEnglish } from "../../../i18n/locales/en-chat-session-sharing.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import {
  canManageChatSessionSharing,
  type ChatSessionSharingAction,
  type ChatSessionSharingOutcome,
  type ChatSessionSharingProps,
} from "./chat-session-sharing-shared.tsx";

registerEnglishCatalog(registerChatSessionSharingEnglish);

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
  if (!value?.startsWith("permission:")) {
    return;
  }
  const separator = value.indexOf(":", "permission:".length);
  const level = value.slice("permission:".length, separator);
  const identityId = value.slice(separator + 1);
  const permission = projectChatSessionSharingRoster(props).find(
    (row) => row.identity.id === identityId,
  );
  const access = permission?.options.find((option) => option === level);
  if (
    !permission ||
    permission.fixed ||
    permission.disabledReason ||
    permission.level === level ||
    !access
  ) {
    return { status: "unavailable" };
  }
  if (permission.invitedAccess) {
    return props.onMemberAccessChange?.(identityId, access);
  }
  if (props.session.visibility !== "read-only" && props.session.visibility !== "suggest") {
    return { status: "unavailable" };
  }
  const member = level === "send";
  const reason = member ? props.memberAddDisabledReason : props.memberRemoveDisabledReason;
  if (!reason) {
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
  const activity = createMemo(() => {
    const target = scope();
    const [saving, setSaving] = createOptimistic(false);
    return { target, saving, setSaving };
  });
  const [completion, setCompletion] = createSignal<Promise<void> | undefined>(() => {
    scope();
    return undefined;
  });
  const disposed = Promise.withResolvers<void>();
  onSettled(() => () => disposed.resolve());

  const present = action(function* (
    view: ReturnType<typeof activity>,
    pending: Promise<void | ChatSessionSharingOutcome>,
  ): Generator<
    Promise<void | ChatSessionSharingOutcome>,
    void | ChatSessionSharingOutcome,
    void | ChatSessionSharingOutcome
  > {
    const { target } = view;
    const retired = Promise.withResolvers<void>();
    const stop = target.signal
      ? listen(target.signal, "abort", () => retired.resolve(), { once: true })
      : undefined;
    if (target.signal?.aborted) {
      retired.resolve();
    } else if (scope() === target) {
      view.setSaving(true);
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
    const view = activity();
    const { target } = view;
    const pending = (async () => {
      // Admission and its synchronous publication precede the presentation transaction.
      const selected = selectChatSessionSharingItem(props, value);
      if (!(selected instanceof Promise)) {
        return selected;
      }
      await Promise.resolve();
      return await present(view, selected);
    })().catch((cause: unknown) => {
      if (!target.signal?.aborted && scope() === target) {
        throw cause;
      }
    });
    const completed = pending.then(() => undefined);
    void setCompletion(completed);
    // The view may retire before its error slot observes this operation.
    void completed.catch(() => undefined);
    return pending.catch(
      (cause: unknown) =>
        ({
          status: "failed",
          error: formatUiError(cause),
        }) satisfies ChatSessionSharingOutcome,
    );
  }

  return { read, scope, select, completion, busy: () => activity().saving() };
}

export function chatSessionPermissionLabel(level: SessionMemberPermissionLevel) {
  return t(
    level === "send"
      ? "chat.sessionSharing.canSend"
      : level === "suggest"
        ? "chat.sessionSharing.canSuggest"
        : "chat.sessionSharing.canRead",
  );
}

export type ChatSessionSharingRosterRow = {
  identity: NonNullable<SessionMembersListEvidenceResult["owner"]>;
  owner: boolean;
  fixed: boolean;
  level?: SessionMemberPermissionLevel;
  options: readonly SessionMemberPermissionLevel[];
  controlLabel: string;
  disabledReason?: string;
  invitedAccess?: boolean;
  loweringAccessNote?: string;
};

export function projectChatSessionSharingRoster(
  input: ChatSessionSharingProps,
): ChatSessionSharingRosterRow[] {
  const result = input.state?.result;
  const identities = new Map(result?.identities.map((identity) => [identity.id, identity]));
  const invitationOnly =
    input.session?.visibility !== "read-only" && input.session?.visibility !== "suggest";
  const rows: ChatSessionSharingRosterRow[] = (result?.permissions ?? [])
    .flatMap((permission) => {
      const identity = identities.get(permission.identityId);
      const invitedAccess = permission.invitation === "member";
      return identity &&
        identity.id !== result?.owner?.id &&
        permission.invitation !== "available" &&
        (!invitationOnly || invitedAccess)
        ? [
            {
              identity,
              owner: false,
              fixed:
                permission.options.length < 2 || (invitedAccess && !input.onMemberAccessChange),
              level: permission.level,
              options: permission.options,
              invitedAccess,
              loweringAccessNote:
                invitedAccess && permission.level !== "read"
                  ? t("chat.sessionSharing.loweringAccessCancelsQueued", {
                      name: identity.label ?? identity.id,
                    })
                  : undefined,
              controlLabel: chatSessionPermissionLabel(permission.level),
              disabledReason: input.state?.loading
                ? t("common.loading")
                : invitedAccess
                  ? input.memberAccessDisabledReason
                  : permission.level === "send"
                    ? input.memberRemoveDisabledReason
                    : input.memberAddDisabledReason,
            },
          ]
        : [];
    })
    .toSorted((a, b) =>
      (a.identity.label ?? a.identity.id).localeCompare(b.identity.label ?? b.identity.id),
    );
  return result?.owner
    ? [
        {
          identity: result.owner,
          owner: true,
          fixed: true,
          options: [],
          controlLabel: t("chat.sessionSharing.owner"),
        },
        ...rows,
      ]
    : rows;
}
