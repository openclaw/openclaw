// Connection-aware OpenClaw ID account menu. Gateway-verified identity owns the
// header; local browser sign-in controls only the loopback onboarding actions.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import {
  openClawIdAccount,
  signInWithOpenClawId,
  signOutOfOpenClawId,
} from "../../lib/openclaw-id/account.ts";
import { signOutOfRemoteOpenClawId } from "../../lib/openclaw-id/remote-sign-out.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import {
  openClawIdErrorToast,
  type OpenClawIdErrorContext,
} from "../../lib/openclaw-id/ui-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { renderSidebarMenuAction } from "../app-sidebar-dropdown.tsx";
import { showConfirmDialog } from "../confirm-dialog.ts";
import { Icon, type IconName } from "../solid/icon.tsx";
import type { MenuEntry } from "../solid/menu.tsx";
import { clawNameFromHostname } from "./claw-name.ts";

registerEnglishCatalog(registerOpenClawIdEnglish);
const VALUE_PREFIX = "openclaw-id:";
const SIGN_IN = `${VALUE_PREFIX}sign-in`;
const MAKE_REACHABLE = `${VALUE_PREFIX}make-reachable`;
const DEVICES = `${VALUE_PREFIX}devices`;
const SIGN_OUT = `${VALUE_PREFIX}sign-out`;
const COPY_LINK = `${VALUE_PREFIX}copy-link`;

/** Derives the compact account header without ever displaying an account ID. */
export function openClawIdMenuIdentity(status: OpenClawIdStatusResult) {
  const identity = status.connection;
  if (status.channel === "tunnel") {
    if (identity?.kind === "member") {
      const role = t(
        identity.role === "viewer" ? "openclawId.roleViewer" : "openclawId.roleOperator",
      );
      return {
        name: identity.email || t("openclawId.accountFallback"),
        detail: t("openclawId.memberRoleOnClaw", {
          role,
          claw: status.link.hostname
            ? clawNameFromHostname(status.link.hostname)
            : t("openclawId.thisClaw"),
        }),
      };
    }
    if (identity?.kind !== "owner") {
      return { name: t("openclawId.accountFallback"), detail: t("openclawId.encryptedConnection") };
    }
    const email = identity.accountEmail;
    const name = identity.accountName;
    return {
      name: name || email || t("openclawId.accountFallback"),
      detail: email ? `${email} · ${t("openclawId.ownerRole")}` : t("openclawId.ownerRole"),
    };
  }
  if (openClawIdAccount()) {
    // Browser storage never supplies the displayed profile; only this RPC does.
    const email = identity?.kind === "local" ? identity.accountEmail : null;
    const name = identity?.kind === "local" ? identity.accountName : null;
    return {
      name: name || email || t("openclawId.accountFallback"),
      detail: email ? `${email} · ${t("openclawId.localOperator")}` : t("openclawId.localOperator"),
    };
  }
  return { name: t("openclawId.localOperator"), detail: t("openclawId.thisComputer") };
}

// One noninteractive status row, aligned with the sidebar's existing icon column.
function statusRow(
  id: string,
  label: string,
  icon: IconName,
  detail?: string | null,
  online?: boolean,
): MenuEntry {
  return {
    kind: "content",
    id: `openclaw-id-${id}`,
    content: (
      <div class="sidebar-openclaw-id__status">
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <span class="sidebar-openclaw-id__lines">
          <span>{label}</span>
          {detail ? <span class="sidebar-openclaw-id__detail">{detail}</span> : undefined}
        </span>
        {online !== undefined ? (
          <span class="sidebar-openclaw-id__pill" data-online={online ? "true" : "false"}>
            {t(online ? "openclawId.online" : "openclawId.offline")}
          </span>
        ) : undefined}
      </div>
    ),
  };
}

// Make reachable is offered only after loopback sign-in.
function makeReachableBlocker(status: OpenClawIdStatusResult): string | undefined {
  if (status.channel !== "local_operator") {
    return t("openclawId.makeReachableLocalOnly");
  }
  return status.services.loaderDomain ? undefined : t("openclawId.needsLoaderDomain");
}

/** One claw card, followed by the devices that can reach it. */
export function openClawIdMenuEntries(status: OpenClawIdStatusResult | null): MenuEntry[] {
  if (!status || status.status.state === "off") {
    return [];
  }
  if (status.channel !== "tunnel" && !openClawIdAccount()) {
    const blocker =
      status.channel !== "local_operator"
        ? t("openclawId.signInLocalOnly")
        : !status.services.clientId
          ? t("openclawId.signInUnconfigured")
          : undefined;
    return [
      {
        id: SIGN_IN,
        label: t("openclawId.signIn"),
        disabled: Boolean(blocker),
        // Preserve menu-owned selection and keyboard registration, with native button semantics.
        render: (attributes) => (
          <button
            {...attributes}
            type="button"
            role="button"
            class="btn sidebar-openclaw-id__sign-in"
            title={blocker}
            disabled={attributes["aria-disabled"] === "true"}
          >
            {t("openclawId.signIn")}
          </button>
        ),
      },
    ];
  }
  const card: MenuEntry[] = [];
  if (status.channel === "tunnel") {
    const connection = status.connection;
    const detail =
      connection?.kind === "owner"
        ? t("openclawId.thisDevice", {
            label: connection.deviceLabel || t("openclawId.unnamedDevice"),
          })
        : connection?.kind === "member" && connection.invitedBy
          ? t("openclawId.invitedBy", {
              owner:
                connection.invitedBy.name ||
                connection.invitedBy.email ||
                t("openclawId.accountFallback"),
            })
          : null;
    card.push(statusRow("encrypted", t("openclawId.encryptedConnection"), "lock", detail));
  } else if (status.link.linked && status.link.hostname && openClawIdAccount()) {
    card.push(
      statusRow(
        "reachable",
        t("openclawId.remoteAccessOn"),
        "radio",
        status.channel === "local_operator" ? null : status.link.hostname,
        status.status.tunnel?.relayOnline === true,
      ),
    );
    if (status.channel === "local_operator") {
      card.push({
        id: COPY_LINK,
        label: t("openclawId.copyRemoteLink"),
        class: "sidebar-openclaw-id__address",
        attributes: { "aria-description": status.link.hostname },
        content: <span class="sidebar-openclaw-id__detail">{status.link.hostname}</span>,
        details: <Icon name="copy" />,
      });
    }
  } else {
    const blocker = makeReachableBlocker(status);
    card.push(
      renderSidebarMenuAction(MAKE_REACHABLE, t("openclawId.makeReachable"), "radio", {
        disabled: Boolean(blocker),
        title: blocker,
        details: <Icon name="arrowRight" />,
      }),
    );
  }
  const entries: MenuEntry[] = [
    {
      kind: "group",
      id: "openclaw-id-card",
      class: "sidebar-openclaw-id__card",
      items: card,
    },
  ];
  if (status.owner && status.link.linked && (status.channel === "tunnel" || openClawIdAccount())) {
    entries.push(
      renderSidebarMenuAction(DEVICES, t("openclawId.yourDevices"), "monitor", {
        details: <span class="sidebar-openclaw-id__count">{status.ownerDeviceCount ?? 0}</span>,
      }),
    );
  }
  return entries;
}

/** Sign-out is the final account action; remote sessions use the loader's actual mechanism. */
export function openClawIdSignOutEntries(status: OpenClawIdStatusResult | null): MenuEntry[] {
  if (!status || status.status.state === "off") {
    return [];
  }
  const available =
    status.channel === "tunnel"
      ? Boolean(navigator.serviceWorker?.controller)
      : status.channel === "local_operator" && Boolean(openClawIdAccount());
  return available
    ? [renderSidebarMenuAction(SIGN_OUT, t("openclawId.signOut"), "arrowRight")]
    : [];
}

// Runs a lazily loaded dialog; a failed load or dialog error shows one toast.
function openDialog(open: () => Promise<unknown>, context: OpenClawIdErrorContext = "open") {
  open().catch((error: unknown) =>
    showToast({
      severity: "error",
      message: openClawIdErrorToast(error, context),
      durationMs: 12_000,
    }),
  );
}

// Opens Make reachable, with the link code taken from the account when signed in.
function startMakeReachable(client: GatewayBrowserClient, loaderDomain: string) {
  openDialog(async () =>
    (await import("./make-reachable-dialog.tsx")).showMakeReachableDialog({
      client,
      loaderDomain,
      signedIn: openClawIdAccount(),
    }),
  );
}

// After sign-in on an unlinked claw: offer Make reachable (dismissing is "Not now").
function offerMakeReachable(
  client: GatewayBrowserClient,
  status: OpenClawIdStatusResult | null,
  account: string,
) {
  const loaderDomain = status?.services.loaderDomain;
  if (!status || status.link.linked || !loaderDomain || makeReachableBlocker(status)) {
    showToast({ severity: "success", message: t("openclawId.signedIn", { account }) });
    return;
  }
  showToast({
    severity: "info",
    message: t("openclawId.reachOffer", { account }),
    actionLabel: t("openclawId.makeReachable"),
    onAction: () => startMakeReachable(client, loaderDomain),
    durationMs: 30_000,
  });
}

/**
 * Runs an OpenClaw ID menu command. Returns false for values it does not own.
 * Call synchronously from the menu selection so the sign-in popup keeps the
 * click's user activation.
 */
export function selectOpenClawIdMenuValue(
  value: string,
  context: {
    status: OpenClawIdStatusResult | null;
    client: GatewayBrowserClient | null | undefined;
    basePath: string;
  },
): boolean {
  if (!value.startsWith(VALUE_PREFIX) || !context.status || context.status.status.state === "off") {
    return false;
  }
  const { client, status } = context;
  if (value === DEVICES && client && status?.owner) {
    openDialog(async () =>
      (await import("./owner-devices-dialog.tsx")).showOwnerDevicesDialog({ client }),
    );
  } else if (value === COPY_LINK && status?.channel === "local_operator" && status.link.hostname) {
    void copyToClipboard(`https://${status.link.hostname}`).then((copied) =>
      showToast({
        severity: copied ? "success" : "error",
        message: t(copied ? "openclawId.remoteLinkCopied" : "openclawId.remoteLinkCopyFailed"),
      }),
    );
  } else if (value === SIGN_OUT) {
    if (status?.channel === "tunnel") {
      openDialog(signOutOfRemoteOpenClawId, "signOut");
    } else {
      openDialog(async () => {
        const confirmed = await showConfirmDialog({
          title: t("openclawId.signOut"),
          message: t("openclawId.signOutReachability"),
          confirmLabel: t("openclawId.signOut"),
        });
        if (confirmed) {
          signOutOfOpenClawId();
        }
      }, "signOut");
    }
  } else if (value === SIGN_IN && client) {
    signInWithOpenClawId({ client, basePath: context.basePath }).then(
      (signedIn) =>
        offerMakeReachable(client, status, signedIn.email ?? t("openclawId.accountFallback")),
      (error: unknown) =>
        showToast({
          severity: "error",
          message: openClawIdErrorToast(error, "signIn"),
          durationMs: 12_000,
        }),
    );
  } else if (value === MAKE_REACHABLE && client && status?.services.loaderDomain) {
    startMakeReachable(client, status.services.loaderDomain);
  }
  return true;
}
