import { createMemo } from "solid-js";
import type { SessionVisibility } from "../../../api/types.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type {
  ChatSessionAccessMobileProps,
  ChatSessionSharingMobileLabels,
  ChatSessionSharingMobileProps,
  ChatSessionSharingModePresentation,
} from "./chat-session-sharing-mobile.tsx";
import type { ChatSessionSharingOptionsProps } from "./chat-session-sharing-options.tsx";
import type { PreparedChatSessionSharing } from "./chat-session-sharing-shared.tsx";
import {
  canManageChatSessionSharing,
  CHAT_SESSION_SHARING_DESCRIPTION_KEYS,
  ChatSessionSharingModeIcon,
  projectChatSessionSharingRoster,
  selectChatSessionSharingItem,
} from "./chat-session-sharing.solid.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

export type ChatSessionSharingMobileNavigation = {
  onOpenSharing: () => void;
  onOpenAccess: () => void;
  onApplied: () => void;
  /** Host-owned destination instance; undefined while Session access is not presented. */
  accessTarget: () => object | undefined;
};

export type ChatSessionSharingMobileAdapter = {
  readonly available: boolean;
  options: ChatSessionSharingOptionsProps;
  sharing: ChatSessionSharingMobileProps;
  access: ChatSessionAccessMobileProps;
  /** Call on native destination entry/re-entry, not on every render. */
  prepare: () => void;
};

/** Create once under the retained session owner; read must expose live native Sharing props. */
export function createChatSessionSharingMobileAdapter(
  read: () => PreparedChatSessionSharing | null | undefined,
  navigation: ChatSessionSharingMobileNavigation,
): ChatSessionSharingMobileAdapter {
  const source = createMemo(read);
  const visibility = () => source()?.session?.visibility ?? "shared";
  const pending = () => source()?.state?.loading === true;
  const unavailable = () => {
    const current = source();
    if (!current?.session) {
      return t("sessionsView.actionUnavailable");
    }
    if (!canManageChatSessionSharing(current.session)) {
      return t("sessionsView.actionRequiresOwnership");
    }
    return current.openDisabledReason;
  };
  const accessReason = () => unavailable() ?? source()?.visibilityDisabledReason;
  const rows = createMemo(() => {
    const current = source();
    const reason = unavailable();
    const projected = current ? projectChatSessionSharingRoster(current) : [];
    for (const row of projected) {
      row.disabledReason ??= reason;
    }
    return projected;
  });
  const allowed = createMemo(
    () =>
      source()?.state?.result?.allowedVisibilities ??
      source()?.allowedVisibilities ?? [visibility()],
  );
  const mode = (value: SessionVisibility) => ({
    get description() {
      return t(CHAT_SESSION_SHARING_DESCRIPTION_KEYS[value]);
    },
    icon: () => <ChatSessionSharingModeIcon visibility={value} />,
  });
  const modes: ChatSessionSharingModePresentation = {
    shared: mode("shared"),
    "read-only": mode("read-only"),
    suggest: mode("suggest"),
    draft: mode("draft"),
  };
  const labels: ChatSessionSharingMobileLabels = {
    get sessionAccess() {
      return t("chat.sessionSharing.sessionAccess");
    },
    get linkSharing() {
      return t("chat.sessionSharing.linkSharing");
    },
    get anyoneWithLink() {
      return t("chat.sessionSharing.anyoneWithLink");
    },
    get messagePermissions() {
      return t("chat.sessionSharing.messagePermissions");
    },
    get showSearch() {
      return t("chat.sessionSharing.searchPeople");
    },
    get hideSearch() {
      return t("chat.sessionSharing.closeSearch");
    },
  };
  const prepare = () => {
    if (!unavailable()) {
      source()?.onOpen();
    }
  };
  const publicLink: NonNullable<ChatSessionSharingMobileProps["publicLink"]> = {
    get enabled() {
      return Boolean(source()?.state?.result?.publicShare);
    },
    get description() {
      return t(
        visibility() === "draft"
          ? "chat.sessionSharing.publicDraftDescription"
          : "chat.sessionSharing.publicLinkDescription",
      );
    },
    get url() {
      return source()?.state?.publicUrl;
    },
    get disabledReason() {
      return (
        unavailable() ??
        source()?.publicShareDisabledReason ??
        (pending()
          ? t("common.loading")
          : !source()?.state?.result
            ? t("sessionsView.actionUnavailable")
            : undefined)
      );
    },
    get copyDisabledReason() {
      return (
        unavailable() ??
        (pending()
          ? t("common.loading")
          : !publicLink.enabled || !publicLink.url || !source()?.onCopyPublicLink
            ? t("chat.sessionSharing.linkUnavailable")
            : undefined)
      );
    },
    onChange: (enabled) => {
      const current = source();
      if (current && !publicLink.disabledReason && enabled !== publicLink.enabled) {
        void selectChatSessionSharingItem(current, enabled ? "public:enable" : "public:disable");
      }
    },
    onCopy: () => {
      const current = source();
      if (current && !publicLink.copyDisabledReason) {
        void selectChatSessionSharingItem(current, "public:copy");
      }
    },
  };
  const permissions: NonNullable<ChatSessionSharingMobileProps["permissions"]> = {
    get rows() {
      return rows();
    },
    get loading() {
      return pending();
    },
    get personActivity() {
      return source()?.personActivity;
    },
    onMemberChange: (identityId, member) => {
      const current = source();
      const row = rows().find((candidate) => candidate.identity.id === identityId);
      if (
        current &&
        !unavailable() &&
        row &&
        !row.fixed &&
        !row.disabledReason &&
        row.selected !== member
      ) {
        void selectChatSessionSharingItem(current, `member:${identityId}`);
      }
    },
  };
  return {
    get available() {
      const session = source()?.session;
      return Boolean(session && canManageChatSessionSharing(session));
    },
    prepare,
    options: {
      get visibility() {
        return visibility();
      },
      get publicShare() {
        return publicLink.enabled;
      },
      get openDisabledReason() {
        return unavailable();
      },
      onOpen: () => {
        if (!unavailable()) {
          prepare();
          navigation.onOpenSharing();
        }
      },
    },
    sharing: {
      get visibility() {
        return visibility();
      },
      modes,
      labels,
      get accessDisabledReason() {
        return accessReason();
      },
      get error() {
        return source()?.state?.error;
      },
      get publicLink() {
        return source()?.onPublicShareChange ? publicLink : undefined;
      },
      get permissions() {
        const current = source();
        return current &&
          current.membersAvailable !== false &&
          (!current.state?.result || pending() || current.state?.error || rows().length > 0)
          ? permissions
          : undefined;
      },
      onOpenAccess: () => {
        if (!accessReason()) {
          navigation.onOpenAccess();
        }
      },
    },
    access: {
      get visibility() {
        return visibility();
      },
      modes,
      get allowedVisibilities() {
        return allowed();
      },
      get label() {
        return labels.sessionAccess;
      },
      get pending() {
        return pending();
      },
      get disabledReason() {
        return accessReason();
      },
      get error() {
        return source()?.state?.error;
      },
      onVisibilityChange: async (value) => {
        const current = source();
        const target = navigation.accessTarget();
        const session = current?.session;
        if (!current || !session || !target || accessReason() || pending()) {
          return false;
        }
        const sessionKey = session.key;
        const sessionId = session.sessionId;
        const outcome = await selectChatSessionSharingItem(current, `visibility:${value}`);
        const latestSession = source()?.session;
        return (
          outcome?.status === "success" &&
          navigation.accessTarget() === target &&
          latestSession?.key === sessionKey &&
          latestSession?.sessionId === sessionId
        );
      },
      onApplied: () => navigation.onApplied(),
    },
  };
}
