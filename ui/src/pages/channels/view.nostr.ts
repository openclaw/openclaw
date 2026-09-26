// Channels page renders Nostr status.
import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, NostrStatus } from "../../api/types.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import {
  renderNostrProfileForm,
  type NostrProfileFormState,
  type NostrProfileFormCallbacks,
} from "./view.nostr-profile-form.ts";
import {
  boolStatusKind,
  renderChannelAccountRow,
  renderChannelActionRow,
  renderChannelErrorRow,
  renderChannelFacts,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

function truncatePubkey(pubkey: string | null | undefined): string {
  if (!pubkey) {
    return t("common.na");
  }
  if (pubkey.length <= 20) {
    return pubkey;
  }
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export function renderNostrCard(params: {
  props: ChannelsProps;
  nostr?: NostrStatus | null;
  nostrAccounts: ChannelAccountSnapshot[];
  accountCount?: number;
  profileFormState?: NostrProfileFormState | null;
  profileFormCallbacks?: NostrProfileFormCallbacks | null;
  onEditProfile?: () => void;
}) {
  const {
    props,
    nostr,
    nostrAccounts,
    accountCount,
    profileFormState,
    profileFormCallbacks,
    onEditProfile,
  } = params;
  const primaryAccount = nostrAccounts[0];
  const summaryConfigured = nostr?.configured ?? primaryAccount?.configured ?? false;
  const summaryRunning = nostr?.running ?? primaryAccount?.running ?? false;
  const summaryPublicKey =
    nostr?.publicKey ?? (primaryAccount as { publicKey?: string } | undefined)?.publicKey;
  const summaryLastStartAt = nostr?.lastStartAt ?? primaryAccount?.lastStartAt ?? null;
  const summaryLastError = nostr?.lastError ?? primaryAccount?.lastError ?? null;
  const hasMultipleAccounts = nostrAccounts.length > 1;
  const showingForm = profileFormState !== null && profileFormState !== undefined;

  const renderAccountRow = (account: ChannelAccountSnapshot) => {
    const publicKey = (account as { publicKey?: string }).publicKey;
    const profile = (account as { profile?: { name?: string; displayName?: string } }).profile;
    const displayName = profile?.displayName ?? profile?.name ?? account.name ?? account.accountId;

    return renderChannelAccountRow({
      title: displayName,
      accountId: account.accountId,
      facts: [
        `${t("common.configured")}: ${account.configured ? t("common.yes") : t("common.no")}`,
        `${t("common.publicKey")}: ${truncatePubkey(publicKey)}`,
      ],
      status: {
        kind: boolStatusKind(account.running),
        label: account.running ? t("common.running") : t("common.no"),
      },
      lastInboundAt: account.lastInboundAt,
      lastError: account.lastError,
    });
  };

  const renderProfileSection = () => {
    if (showingForm && profileFormCallbacks) {
      return renderNostrProfileForm({
        state: profileFormState,
        callbacks: profileFormCallbacks,
        accountId: nostrAccounts[0]?.accountId ?? "default",
      });
    }

    const profile =
      (
        primaryAccount as
          | {
              profile?: {
                name?: string;
                displayName?: string;
                about?: string;
                picture?: string;
                nip05?: string;
              };
            }
          | undefined
      )?.profile ?? nostr?.profile;
    const { name, displayName, about, picture, nip05 } = profile ?? {};
    const hasAnyProfileData = name || displayName || about || picture || nip05;

    return html`
      <div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">${t("channels.nostr.profile")}</span>
          ${
            hasAnyProfileData
              ? nothing
              : html`<span class="settings-row__desc"
                  >${t("channels.nostr.noProfile")} ${t("channels.nostr.noProfileHint")}</span
                >`
          }
        </div>
        ${
          summaryConfigured
            ? html`
                <div class="settings-row__control">
                  <button class="btn btn--sm" @click=${onEditProfile}>
                    ${t("channels.nostr.editProfile")}
                  </button>
                </div>
              `
            : nothing
        }
      </div>
      ${
        hasAnyProfileData
          ? html`
              <dl class="settings-kv">
                ${
                  picture
                    ? html`
                        <dt>${t("channels.nostr.profilePicture")}</dt>
                        <dd>
                          <img
                            style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover;"
                            src=${picture}
                            alt=${t("channels.nostr.profilePicture")}
                            @error=${(e: Event) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                        </dd>
                      `
                    : nothing
                }
                ${[
                  [t("channels.nostr.name"), name],
                  [t("channels.nostr.displayName"), displayName],
                  [t("channels.nostr.about"), about],
                  ["NIP-05", nip05],
                ].map(([label, value]) =>
                  value
                    ? html`<dt>${label}</dt>
                        <dd>${value}</dd>`
                    : nothing,
                )}
              </dl>
            `
          : nothing
      }
    `;
  };

  return renderSettingsSection(
    {
      title: t("channels.nostr.title"),
      description: t("channels.nostr.subtitle"),
      ...(accountCount !== undefined ? { count: accountCount } : {}),
    },
    html`
      ${
        hasMultipleAccounts
          ? nostrAccounts.map((account) => renderAccountRow(account))
          : renderChannelFacts([
              {
                label: t("common.configured"),
                value: summaryConfigured ? t("common.yes") : t("common.no"),
                kind: boolStatusKind(summaryConfigured),
              },
              {
                label: t("common.running"),
                value: summaryRunning ? t("common.yes") : t("common.no"),
                kind: boolStatusKind(summaryRunning),
              },
              {
                label: t("common.publicKey"),
                value: html`<code title="${summaryPublicKey ?? ""}"
                  >${truncatePubkey(summaryPublicKey)}</code
                >`,
              },
              {
                label: t("common.lastStart"),
                value: summaryLastStartAt
                  ? formatRelativeTimestamp(summaryLastStartAt)
                  : t("common.na"),
              },
            ])
      }
      ${summaryLastError ? renderChannelErrorRow(summaryLastError) : nothing}
      ${renderProfileSection()} ${renderChannelConfigSection({ channelId: "nostr", props })}
      ${renderChannelActionRow(
        html`<button class="btn" @click=${() => props.onRefresh(false)}>
          ${t("common.refresh")}
        </button>`,
      )}
    `,
  );
}
