import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import type { ChannelAccountSnapshot, NostrProfile, NostrStatus } from "../../api/types.ts";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderChannelConfigSection } from "./view.config.tsx";
import {
  renderNostrProfileForm as NostrProfileForm,
  type NostrProfileFormState,
  type NostrProfileFormCallbacks,
} from "./view.nostr-profile-form.tsx";
import {
  boolStatusKind,
  renderChannelAccountRow,
  renderChannelActionRow,
  renderChannelErrorRow,
  renderChannelFacts,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

function truncatePubkey(pubkey: string | null | undefined): string {
  if (!pubkey) {
    return t("common.na");
  }
  return pubkey.length <= 20 ? pubkey : `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
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
  const primaryAccount = createMemo(() => params.nostrAccounts[0]);
  const summaryConfigured = createMemo(
    () => params.nostr?.configured ?? primaryAccount()?.configured ?? false,
  );
  const summaryRunning = createMemo(
    () => params.nostr?.running ?? primaryAccount()?.running ?? false,
  );
  const summaryPublicKey = createMemo(
    () =>
      params.nostr?.publicKey ?? readStringField(asNullableRecord(primaryAccount()), "publicKey"),
  );
  const summaryLastStartAt = createMemo(
    () => params.nostr?.lastStartAt ?? primaryAccount()?.lastStartAt ?? null,
  );
  const summaryLastError = createMemo(
    () => params.nostr?.lastError ?? primaryAccount()?.lastError ?? null,
  );
  const hasMultipleAccounts = createMemo(() => params.nostrAccounts.length > 1);

  const renderAccountRow = (account: ChannelAccountSnapshot) => {
    const publicKey = readStringField(asNullableRecord(account), "publicKey");
    // SAFETY: Nostr resolveAccountSnapshot copies its schema-validated account.profile into this metadata field.
    const profile = asNullableRecord(account)?.profile as NostrProfile | null | undefined;
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
    // SAFETY: These are Nostr account snapshots; their profile metadata comes from the plugin's validated config.
    const accountProfile = asNullableRecord(primaryAccount())?.profile as
      | NostrProfile
      | null
      | undefined;
    const profile = accountProfile ?? params.nostr?.profile;
    const { name, displayName, about, picture, nip05 } = profile ?? {};
    const hasAnyProfileData = name || displayName || about || picture || nip05;

    return (
      <>
        {
          <SettingsRow
            {...{
              title: t("channels.nostr.profile"),
              description: hasAnyProfileData ? undefined : (
                <>
                  {t("channels.nostr.noProfile")} {t("channels.nostr.noProfileHint")}
                </>
              ),
              control: summaryConfigured() ? (
                <button class="btn btn--sm" onClick={() => params.onEditProfile?.()}>
                  {t("channels.nostr.editProfile")}
                </button>
              ) : undefined,
            }}
          />
        }
        {hasAnyProfileData ? (
          <dl class="settings-kv">
            {picture ? (
              <>
                <dt>{t("channels.nostr.profilePicture")}</dt>
                <dd>
                  <img
                    style={{
                      width: "48px",
                      height: "48px",
                      "border-radius": "50%",
                      "object-fit": "cover",
                    }}
                    src={picture}
                    alt={t("channels.nostr.profilePicture")}
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                </dd>
              </>
            ) : undefined}
            {
              <For
                each={[
                  [t("channels.nostr.name"), name],
                  [t("channels.nostr.displayName"), displayName],
                  [t("channels.nostr.about"), about],
                  ["NIP-05", nip05],
                ]}
              >
                {([label, value]) =>
                  value ? (
                    <>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </>
                  ) : undefined
                }
              </For>
            }
          </dl>
        ) : undefined}
      </>
    );
  };

  return (
    <SettingsSection
      {...{
        title: t("channels.nostr.title"),
        description: t("channels.nostr.subtitle"),
        ...(params.accountCount !== undefined ? { count: params.accountCount } : {}),
      }}
    >
      {
        <>
          {hasMultipleAccounts()
            ? params.nostrAccounts.map((account) => renderAccountRow(account))
            : renderChannelFacts([
                {
                  label: t("common.configured"),
                  value: summaryConfigured() ? t("common.yes") : t("common.no"),
                  kind: boolStatusKind(summaryConfigured()),
                },
                {
                  label: t("common.running"),
                  value: summaryRunning() ? t("common.yes") : t("common.no"),
                  kind: boolStatusKind(summaryRunning()),
                },
                {
                  label: t("common.publicKey"),
                  value: (
                    <code title={summaryPublicKey() ?? ""}>
                      {truncatePubkey(summaryPublicKey())}
                    </code>
                  ),
                },
                {
                  label: t("common.lastStart"),
                  value: summaryLastStartAt()
                    ? formatRelativeTimestamp(summaryLastStartAt())
                    : t("common.na"),
                },
              ])}
          {summaryLastError() ? renderChannelErrorRow(summaryLastError()) : undefined}
          <Show
            when={Boolean(params.profileFormState && params.profileFormCallbacks)}
            fallback={renderProfileSection()}
          >
            <NostrProfileForm
              state={params.profileFormState!}
              callbacks={params.profileFormCallbacks!}
              accountId={params.nostrAccounts[0]?.accountId ?? "default"}
            />
          </Show>{" "}
          {renderChannelConfigSection({ channelId: "nostr", props: params.props })}
          {renderChannelActionRow(
            <button class="btn" onClick={() => params.props.onRefresh(false)}>
              {t("common.refresh")}
            </button>,
          )}
        </>
      }
    </SettingsSection>
  );
}
