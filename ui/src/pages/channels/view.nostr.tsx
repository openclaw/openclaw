import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, Show } from "solid-js";
import type { ChannelAccountSnapshot, NostrProfile, NostrStatus } from "../../api/types.ts";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ChannelConfig } from "./view.config.tsx";
import { renderNostrProfileForm as NostrProfileForm } from "./view.nostr-profile-form.tsx";
import {
  boolStatusKind,
  booleanChannelFact,
  resolveChannelAccountCount,
  ChannelAccount,
  ChannelActions,
  ChannelError,
  ChannelFacts,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

function truncatePubkey(pubkey: string | null | undefined): string {
  if (!pubkey) {
    return t("common.na");
  }
  return pubkey.length <= 20 ? pubkey : `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export function NostrCard(props: ChannelsProps) {
  const snapshot = () => props.channels.channelsSnapshot;
  const accounts = createMemo(() => resolveChannelAccounts(snapshot()?.channelAccounts, "nostr"));
  const nostr = createMemo(() => {
    // SAFETY: The bundled Nostr plugin owns the channels.nostr status payload.
    return snapshot()?.channels.nostr as NostrStatus | undefined;
  });
  const accountId = () => accounts()[0]?.accountId ?? "default";
  const form = createMemo(() =>
    props.nostrProfileAccountId === accountId() ? props.nostrProfileFormState : null,
  );
  const primaryAccount = () => accounts()[0];
  const configured = () => nostr()?.configured ?? primaryAccount()?.configured ?? false;
  const publicKey = () =>
    nostr()?.publicKey ?? readStringField(asNullableRecord(primaryAccount()), "publicKey");
  const lastStart = () => nostr()?.lastStartAt ?? primaryAccount()?.lastStartAt;
  const lastError = () => nostr()?.lastError ?? primaryAccount()?.lastError;

  const renderAccountRow = (account: ChannelAccountSnapshot) => {
    const accountPublicKey = readStringField(asNullableRecord(account), "publicKey");
    // SAFETY: Nostr resolveAccountSnapshot copies its schema-validated account.profile into this metadata field.
    const profile = asNullableRecord(account)?.profile as NostrProfile | null | undefined;
    const displayName = profile?.displayName ?? profile?.name ?? account.name ?? account.accountId;

    return (
      <ChannelAccount
        title={displayName}
        accountId={account.accountId}
        facts={[
          `${t("common.configured")}: ${account.configured ? t("common.yes") : t("common.no")}`,
          `${t("common.publicKey")}: ${truncatePubkey(accountPublicKey)}`,
        ]}
        status={{
          kind: boolStatusKind(account.running),
          label: account.running ? t("common.running") : t("common.no"),
        }}
        lastInboundAt={account.lastInboundAt}
        lastError={account.lastError}
      />
    );
  };

  const profile = createMemo(() => {
    // SAFETY: Nostr account profile metadata comes from the plugin's schema-validated config.
    const accountProfile = asNullableRecord(primaryAccount())?.profile as
      | NostrProfile
      | null
      | undefined;
    return accountProfile ?? nostr()?.profile ?? null;
  });
  const renderProfileSection = () => {
    const { name, displayName, about, picture, nip05 } = profile() ?? {};
    const hasAnyProfileData = name || displayName || about || picture || nip05;

    return (
      <>
        <SettingsRow
          title={t("channels.nostr.profile")}
          description={
            hasAnyProfileData ? undefined : (
              <>
                {t("channels.nostr.noProfile")} {t("channels.nostr.noProfileHint")}
              </>
            )
          }
          control={
            configured() ? (
              <button
                class="btn btn--sm"
                onClick={() => props.onNostrProfileEdit(accountId(), profile())}
              >
                {t("channels.nostr.editProfile")}
              </button>
            ) : undefined
          }
        />
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
          </dl>
        ) : undefined}
      </>
    );
  };

  return (
    <SettingsSection
      title={t("channels.nostr.title")}
      description={t("channels.nostr.subtitle")}
      count={resolveChannelAccountCount("nostr", snapshot()?.channelAccounts)}
    >
      {accounts().length > 1 ? (
        accounts().map((account) => renderAccountRow(account))
      ) : (
        <ChannelFacts
          rows={[
            booleanChannelFact("configured", configured()),
            booleanChannelFact("running", nostr()?.running ?? primaryAccount()?.running ?? false),
            {
              label: t("common.publicKey"),
              value: <code title={publicKey() ?? ""}>{truncatePubkey(publicKey())}</code>,
            },
            {
              label: t("common.lastStart"),
              value: lastStart() ? formatRelativeTimestamp(lastStart()) : t("common.na"),
            },
          ]}
        />
      )}
      {lastError() ? <ChannelError message={lastError()} /> : undefined}
      <Show when={form()} fallback={renderProfileSection()}>
        {(state) => (
          <NostrProfileForm
            state={state()}
            accountId={accountId()}
            callbacks={{
              onFieldChange: props.onNostrProfileFieldChange,
              onSave: props.onNostrProfileSave,
              onImport: props.onNostrProfileImport,
              onCancel: props.onNostrProfileCancel,
              onToggleAdvanced: props.onNostrProfileToggleAdvanced,
            }}
          />
        )}
      </Show>
      <ChannelConfig channelId={"nostr"} props={props} />
      <ChannelActions>
        <button class="btn" onClick={() => props.onRefresh(false)}>
          {t("common.refresh")}
        </button>
      </ChannelActions>
    </SettingsSection>
  );
}
