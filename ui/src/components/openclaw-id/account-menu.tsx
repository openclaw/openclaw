// The OpenClaw ID section of the sidebar account (identity) menu. It appears
// only while the Labs flag (gateway.openclawId.enabled) is on and follows the
// onboarding mockup (steps 2, 4 and 9): Sign in with OpenClaw ID, the account,
// Make reachable or the linked address, People (the openclaw-id-access plugin
// page), Your devices (owner devices, revoke) and Sign out. The link-code path
// of Make reachable stays available when signed out.
import { createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pluginTabLocation } from "../../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../../app/context.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  openClawIdAccount,
  signInWithOpenClawId,
  signOutOfOpenClawId,
} from "../../lib/openclaw-id/account.ts";
import type { OpenClawIdStatusResult } from "../../lib/openclaw-id/types.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { renderSidebarMenuAction } from "../app-sidebar-dropdown.tsx";
import type { MenuEntry } from "../solid/menu.tsx";
import { clawNameFromHostname } from "./claw-name.ts";

registerEnglishCatalog(registerOpenClawIdEnglish);

/** The bundled plugin page ("People") for invites, requests and members. */
export const OPENCLAW_ID_PEOPLE_PAGE = { pluginId: "openclaw-id-access", id: "people" } as const;

const VALUE_PREFIX = "openclaw-id:";
const SIGN_IN = `${VALUE_PREFIX}sign-in`;
const MAKE_REACHABLE = `${VALUE_PREFIX}make-reachable`;
const PEOPLE = `${VALUE_PREFIX}people`;
const DEVICES = `${VALUE_PREFIX}devices`;
const REGENERATE = `${VALUE_PREFIX}regenerate-owner-key`;
const SIGN_OUT = `${VALUE_PREFIX}sign-out`;
const ACCOUNT = `${VALUE_PREFIX}account`;

/**
 * Reads `openclawId.status` once for an open menu. Resolves to null while the
 * flag is off, on Gateways without OpenClaw ID, or when the read fails.
 */
export function createOpenClawIdMenuStatus(client: GatewayBrowserClient | null | undefined) {
  const [status, setStatus] = createSignal<OpenClawIdStatusResult | null>(null);
  if (client) {
    void client
      .request<OpenClawIdStatusResult>("openclawId.status", {})
      .then((result) => setStatus(result.status.state === "off" ? null : result))
      .catch(() => setStatus(null));
  }
  return status;
}

// Why sign-in is unavailable here, or undefined when it can start.
function signInBlocker(status: OpenClawIdStatusResult): string | undefined {
  if (status.channel !== "local_operator") {
    return t("openclawId.signInLocalOnly");
  }
  return status.services.clientId ? undefined : t("openclawId.signInUnconfigured");
}

// Why Make reachable is unavailable here, or undefined when it can start.
function makeReachableBlocker(status: OpenClawIdStatusResult): string | undefined {
  if (status.channel !== "local_operator") {
    return t("openclawId.makeReachableLocalOnly");
  }
  return status.services.loaderDomain ? undefined : t("openclawId.needsLoaderDomain");
}

// Spacing of the section's status lines, aligned with the menu's rows. Inline
// so the sketch adds no Control UI CSS; the sidebar-openclaw-id__info hook
// lets a later stylesheet take over.
const INFO_STYLE = { padding: "2px 8px 6px", "font-size": "var(--control-ui-text-xs)" };

// The section's heading line.
function titleLine(id: string, text: string): MenuEntry {
  return {
    kind: "content",
    id: `openclaw-id-${id}`,
    content: <div class="sidebar-customize-menu__title sidebar-openclaw-id__title">{text}</div>,
  };
}

// A non-interactive status line of the section (not a command), in normal case.
function infoLine(id: string, text: string): MenuEntry {
  return {
    kind: "content",
    id: `openclaw-id-${id}`,
    content: (
      <div class="muted sidebar-openclaw-id__info" style={INFO_STYLE}>
        {text}
      </div>
    ),
  };
}

// Signed-out, signed-in or linked account lines (link-flow mockup steps 2 and 9).
function accountEntries(status: OpenClawIdStatusResult): MenuEntry[] {
  const account = openClawIdAccount();
  if (account) {
    const name = account.email ?? account.name ?? account.sub;
    return [
      renderSidebarMenuAction(ACCOUNT, t("openclawId.signedIn", { account: name }), "key", {
        disabled: true,
        className: "sidebar-openclaw-id__account",
      }),
    ];
  }
  const blocker = signInBlocker(status);
  return [
    infoLine("local-operator", t("openclawId.localOperator")),
    renderSidebarMenuAction(SIGN_IN, t("openclawId.signIn"), "key", {
      disabled: Boolean(blocker),
      title: blocker,
    }),
    infoLine("stays-local", t("openclawId.staysLocal")),
  ];
}

// Owner-key regeneration, offered only on a direct-loopback Control UI of a linked
// claw (the Gateway refuses it anywhere else), with the alert for a claw frozen by
// conflicting owner-key changes, which regeneration resolves.
function ownerKeyEntries(status: OpenClawIdStatusResult): MenuEntry[] {
  if (status.channel !== "local_operator" || !status.link.linked) {
    return [];
  }
  return [
    ...(status.link.frozen ? [infoLine("frozen", t("openclawId.frozenAlert"))] : []),
    renderSidebarMenuAction(REGENERATE, t("openclawId.regenerateOwnerKey"), "key"),
  ];
}

// Reachability lines: the linked address and transport, or the Make reachable command.
function reachabilityEntries(status: OpenClawIdStatusResult): MenuEntry[] {
  if (status.link.linked && status.link.hostname) {
    const host = status.link.hostname;
    return [
      renderSidebarMenuAction(
        MAKE_REACHABLE,
        t("openclawId.isReachable", { name: clawNameFromHostname(host) }),
        "radio",
        { disabled: true, className: "sidebar-openclaw-id__reachable" },
      ),
      infoLine("address", `https://${host}`),
      infoLine("encrypted", t("openclawId.encrypted")),
      ...(status.owner
        ? [renderSidebarMenuAction(DEVICES, t("openclawId.yourDevices"), "key")]
        : []),
      ...ownerKeyEntries(status),
    ];
  }
  const blocker = makeReachableBlocker(status);
  return [
    renderSidebarMenuAction(MAKE_REACHABLE, t("openclawId.makeReachable"), "radio", {
      disabled: Boolean(blocker),
      title: blocker,
    }),
  ];
}

/**
 * Menu entries for the OpenClaw ID section; empty while the flag is off.
 * Signed out: local operator, Sign in, "conversations stay on this computer".
 * Signed in: the account. Then Make reachable, or once linked the address and
 * transport and Your devices; People (the openclaw-id-access plugin page), both
 * only for an owner (loopback operator or owner device); on direct loopback,
 * Regenerate owner key (after an alert when conflicting changes froze the claw);
 * Sign out. Unlink is not offered yet (OCF-281 needs a Discovery endpoint).
 */
export function openClawIdMenuEntries(status: OpenClawIdStatusResult | null): MenuEntry[] {
  if (!status) {
    return [];
  }
  return [
    titleLine("title", t("openclawId.menuTitle")),
    ...accountEntries(status),
    ...reachabilityEntries(status),
    // People and Your devices are owner-only (openclawId.people refuses others).
    ...(status.owner ? [renderSidebarMenuAction(PEOPLE, t("openclawId.people"), "users")] : []),
    ...(openClawIdAccount()
      ? [renderSidebarMenuAction(SIGN_OUT, t("openclawId.signOut"), "x")]
      : []),
    {
      kind: "content",
      id: "openclaw-id-separator",
      content: <div class="sidebar-customize-menu__separator" role="separator" />,
    },
  ];
}

// Runs a lazily loaded dialog; a failed load or dialog error shows one toast.
function openDialog(open: () => Promise<unknown>) {
  open().catch((error: unknown) =>
    showToast({
      message: t("openclawId.actionFailed", { error: formatUiError(error) }),
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
    showToast({ message: t("openclawId.signedIn", { account }) });
    return;
  }
  showToast({
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
    onNavigate: (routeId: "plugin", options?: ApplicationNavigationOptions) => void;
  },
): boolean {
  if (!value.startsWith(VALUE_PREFIX)) {
    return false;
  }
  const { client, status } = context;
  if (value === PEOPLE) {
    context.onNavigate("plugin", pluginTabLocation(OPENCLAW_ID_PEOPLE_PAGE, context.basePath));
  } else if (value === DEVICES && client) {
    openDialog(async () =>
      (await import("./owner-devices-dialog.tsx")).showOwnerDevicesDialog({ client }),
    );
  } else if (value === REGENERATE && client) {
    openDialog(async () =>
      (await import("./regenerate-owner-key-dialog.tsx")).showRegenerateOwnerKeyDialog({
        client,
        signedIn: openClawIdAccount(),
      }),
    );
  } else if (value === SIGN_OUT) {
    signOutOfOpenClawId();
  } else if (value === SIGN_IN && client) {
    signInWithOpenClawId({ client, basePath: context.basePath }).then(
      (signedIn) =>
        offerMakeReachable(client, status, signedIn.email ?? signedIn.name ?? signedIn.sub),
      (error: unknown) =>
        showToast({
          message: t("openclawId.signInFailed", { error: formatUiError(error) }),
          durationMs: 12_000,
        }),
    );
  } else if (value === MAKE_REACHABLE && client && status?.services.loaderDomain) {
    startMakeReachable(client, status.services.loaderDomain);
  }
  return true;
}
