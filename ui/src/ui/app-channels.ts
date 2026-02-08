import type { OpenClawApp } from "./app.ts";
import {
  loadChannels,
  logoutWhatsApp,
  startWhatsAppLogin,
  waitWhatsAppLogin,
} from "./controllers/channels.ts";
import { loadConfig, saveConfig } from "./controllers/config.ts";
import type { NostrProfile } from "./types.ts";
import { createNostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

export async function handleWhatsAppStart(host: OpenClawApp, force: boolean) {
  await startWhatsAppLogin(host, force);
  await loadChannels(host, true);
}

export async function handleWhatsAppWait(host: OpenClawApp) {
  await waitWhatsAppLogin(host);
  await loadChannels(host, true);
}

export async function handleWhatsAppLogout(host: OpenClawApp) {
  await logoutWhatsApp(host);
  await loadChannels(host, true);
}

export async function handleChannelConfigSave(host: OpenClawApp) {
  await saveConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleChannelConfigReload(host: OpenClawApp) {
  await loadConfig(host);
  await loadChannels(host, true);
}

function parseValidationErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = message;
    }
  }
  return errors;
}

function resolveNostrAccountId(host: OpenClawApp): string {
  const accounts = host.channelsSnapshot?.channelAccounts?.nostr ?? [];
  return accounts[0]?.accountId ?? host.nostrProfileAccountId ?? "default";
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

function resolveGatewayHttpAuthHeader(host: OpenClawApp): string | null {
  const deviceToken = host.hello?.auth?.deviceToken?.trim();
  if (deviceToken) {
    return `Bearer ${deviceToken}`;
  }
  const token = host.settings.token.trim();
  if (token) {
    return `Bearer ${token}`;
  }
  const password = host.password.trim();
  if (password) {
    return `Bearer ${password}`;
  }
  return null;
}

function buildGatewayHttpHeaders(host: OpenClawApp): Record<string, string> {
  const authorization = resolveGatewayHttpAuthHeader(host);
  return authorization ? { Authorization: authorization } : {};
}

export function handleNostrProfileEdit(
  host: OpenClawApp,
  accountId: string,
  profile: NostrProfile | null,
) {
  host.nostrProfileAccountId = accountId;
  host.nostrProfileFormState = createNostrProfileFormState(profile ?? undefined);
}

export function handleNostrProfileCancel(host: OpenClawApp) {
  host.nostrProfileFormState = null;
  host.nostrProfileAccountId = null;
}

export function handleNostrProfileFieldChange(
  host: OpenClawApp,
  field: keyof NostrProfile,
  value: string,
) {
  const state = host.nostrProfileFormState;
  if (!state) {
    return;
  }
  host.nostrProfileFormState = {
    ...state,
    values: {
      ...state.values,
      [field]: value,
    },
    fieldErrors: {
      ...state.fieldErrors,
      [field]: "",
    },
  };
}

export function handleNostrProfileToggleAdvanced(host: OpenClawApp) {
  const state = host.nostrProfileFormState;
  if (!state) {
    return;
  }
  host.nostrProfileFormState = {
    ...state,
    showAdvanced: !state.showAdvanced,
  };
}

export async function handleNostrProfileSave(host: OpenClawApp) {
  const state = host.nostrProfileFormState;
  if (!state || state.saving) {
    return;
  }
  const accountId = resolveNostrAccountId(host);

  host.nostrProfileFormState = {
    ...state,
    saving: true,
    error: null,
    success: null,
    fieldErrors: {},
  };

  try {
    const response = await fetch(buildNostrProfileUrl(accountId), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...buildGatewayHttpHeaders(host),
      },
      body: JSON.stringify(state.values),
    });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      details?: unknown;
      persisted?: boolean;
    } | null;

    if (!response.ok || data?.ok === false || !data) {
      const errorMessage = data?.error ?? `Profile update failed (${response.status})`;
      host.nostrProfileFormState = {
        ...state,
        saving: false,
        error: errorMessage,
        success: null,
        fieldErrors: parseValidationErrors(data?.details),
      };
      return;
    }

    if (!data.persisted) {
      host.nostrProfileFormState = {
        ...state,
        saving: false,
        error: "Profile publish failed on all relays.",
        success: null,
      };
      return;
    }

    host.nostrProfileFormState = {
      ...state,
      saving: false,
      error: null,
      success: "Profile published to relays.",
      fieldErrors: {},
      original: { ...state.values },
    };
    await loadChannels(host, true);
  } catch (err) {
    host.nostrProfileFormState = {
      ...state,
      saving: false,
      error: `Profile update failed: ${String(err)}`,
      success: null,
    };
  }
}

export async function handleNostrProfileImport(host: OpenClawApp) {
  const state = host.nostrProfileFormState;
  if (!state || state.importing) {
    return;
  }
  const accountId = resolveNostrAccountId(host);

  host.nostrProfileFormState = {
    ...state,
    importing: true,
    error: null,
    success: null,
  };

  try {
    const response = await fetch(buildNostrProfileUrl(accountId, "/import"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildGatewayHttpHeaders(host),
      },
      body: JSON.stringify({ autoMerge: true }),
    });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      imported?: NostrProfile;
      merged?: NostrProfile;
      saved?: boolean;
    } | null;

    if (!response.ok || data?.ok === false || !data) {
      const errorMessage = data?.error ?? `Profile import failed (${response.status})`;
      host.nostrProfileFormState = {
        ...state,
        importing: false,
        error: errorMessage,
        success: null,
      };
      return;
    }

    const merged = data.merged ?? data.imported ?? null;
    const nextValues = merged ? { ...state.values, ...merged } : state.values;
    const showAdvanced = Boolean(
      nextValues.banner || nextValues.website || nextValues.nip05 || nextValues.lud16,
    );

    host.nostrProfileFormState = {
      ...state,
      importing: false,
      values: nextValues,
      error: null,
      success: data.saved
        ? "Profile imported from relays. Review and publish."
        : "Profile imported. Review and publish.",
      showAdvanced,
    };

    if (data.saved) {
      await loadChannels(host, true);
    }
  } catch (err) {
    host.nostrProfileFormState = {
      ...state,
      importing: false,
      error: `Profile import failed: ${String(err)}`,
      success: null,
    };
  }
}

async function createSimplexInvite(
  host: OpenClawApp,
  accountId: string,
  mode: "connect" | "address",
) {
  if (!host.client || !host.connected) {
    return;
  }
  const current = host.simplexControlByAccount[accountId] ?? {
    busyCreate: false,
    busyRevoke: false,
    message: null,
    error: null,
    addressLink: null,
    addressQrDataUrl: null,
    latestOneTimeInviteLink: null,
    latestOneTimeInviteQrDataUrl: null,
  };
  if (current.busyCreate) {
    return;
  }
  host.simplexControlByAccount = {
    ...host.simplexControlByAccount,
    [accountId]: {
      ...current,
      busyCreate: true,
      message: null,
      error: null,
    },
  };
  try {
    const result = await host.client.request<{
      accountId?: string;
      mode?: "connect" | "address";
      link?: string | null;
      qrDataUrl?: string | null;
    }>("simplex.invite.create", {
      accountId,
      mode,
    });
    const resolvedId = result.accountId ?? accountId;
    const existing = host.simplexControlByAccount[resolvedId] ?? {
      busyCreate: false,
      busyRevoke: false,
      message: null,
      error: null,
      addressLink: null,
      addressQrDataUrl: null,
      latestOneTimeInviteLink: null,
      latestOneTimeInviteQrDataUrl: null,
    };
    host.simplexControlByAccount = {
      ...host.simplexControlByAccount,
      [resolvedId]: {
        ...existing,
        busyCreate: false,
        message: result.link
          ? `${mode === "address" ? "Address" : "1-time link"} generated.`
          : null,
        error: null,
        addressLink:
          mode === "address" ? (result.link ?? existing.addressLink) : existing.addressLink,
        addressQrDataUrl:
          mode === "address"
            ? (result.qrDataUrl ?? existing.addressQrDataUrl)
            : existing.addressQrDataUrl,
        latestOneTimeInviteLink:
          mode === "connect" && result.link ? result.link : existing.latestOneTimeInviteLink,
        latestOneTimeInviteQrDataUrl:
          mode === "connect" && result.link
            ? (result.qrDataUrl ?? null)
            : existing.latestOneTimeInviteQrDataUrl,
      },
    };
  } catch (err) {
    const existing = host.simplexControlByAccount[accountId] ?? current;
    host.simplexControlByAccount = {
      ...host.simplexControlByAccount,
      [accountId]: {
        ...existing,
        busyCreate: false,
        message: null,
        error: String(err),
      },
    };
  }
}

export async function handleSimplexOneTimeLinkCreate(host: OpenClawApp, accountId: string) {
  await createSimplexInvite(host, accountId, "connect");
}

async function fetchSimplexInviteList(host: OpenClawApp, accountId: string) {
  const result = await host.client?.request<{
    accountId?: string;
    addressLink?: string | null;
    addressQrDataUrl?: string | null;
  }>("simplex.invite.list", {
    accountId,
  });
  return result ?? null;
}

export async function handleSimplexAddressShowOrCreate(host: OpenClawApp, accountId: string) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const list = await fetchSimplexInviteList(host, accountId);
    const resolvedId = list?.accountId ?? accountId;
    const hasAddress = Boolean(list?.addressLink?.trim());
    if (hasAddress) {
      const existing = host.simplexControlByAccount[resolvedId] ?? {
        busyCreate: false,
        busyRevoke: false,
        message: null,
        error: null,
        addressLink: null,
        addressQrDataUrl: null,
        latestOneTimeInviteLink: null,
        latestOneTimeInviteQrDataUrl: null,
      };
      host.simplexControlByAccount = {
        ...host.simplexControlByAccount,
        [resolvedId]: {
          ...existing,
          message: "Address loaded.",
          error: null,
          addressLink: list?.addressLink ?? null,
          addressQrDataUrl: list?.addressQrDataUrl ?? null,
        },
      };
      return;
    }
  } catch {
    // Fall through to create path.
  }
  await createSimplexInvite(host, accountId, "address");
}

export async function handleSimplexInviteRevoke(host: OpenClawApp, accountId: string) {
  if (!host.client || !host.connected) {
    return;
  }
  const current = host.simplexControlByAccount[accountId] ?? {
    busyCreate: false,
    busyRevoke: false,
    message: null,
    error: null,
    addressLink: null,
    addressQrDataUrl: null,
    latestOneTimeInviteLink: null,
    latestOneTimeInviteQrDataUrl: null,
  };
  if (current.busyRevoke) {
    return;
  }
  host.simplexControlByAccount = {
    ...host.simplexControlByAccount,
    [accountId]: {
      ...current,
      busyRevoke: true,
      message: null,
      error: null,
    },
  };
  try {
    const result = await host.client.request<{ accountId?: string }>("simplex.invite.revoke", {
      accountId,
    });
    const resolvedId = result.accountId ?? accountId;
    const existing = host.simplexControlByAccount[resolvedId] ?? current;
    host.simplexControlByAccount = {
      ...host.simplexControlByAccount,
      [resolvedId]: {
        ...existing,
        busyRevoke: false,
        message: "Address revoked.",
        error: null,
        addressLink: null,
        addressQrDataUrl: null,
      },
    };
  } catch (err) {
    const existing = host.simplexControlByAccount[accountId] ?? current;
    host.simplexControlByAccount = {
      ...host.simplexControlByAccount,
      [accountId]: {
        ...existing,
        busyRevoke: false,
        message: null,
        error: String(err),
      },
    };
  }
}
