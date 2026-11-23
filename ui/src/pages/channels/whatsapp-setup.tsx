import { formatInternationalPhoneNumber } from "@openclaw/normalization-core/phone-presentation";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ChannelsPairingRequest } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { resolveChannelConfigValue } from "../../lib/channels/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import type { ChannelsProps } from "./view.types.ts";

// Fast enough that the first message shows up while the phone is still in hand.
const FIRST_MESSAGE_POLL_MS = 2_000;

// Numbers sit inside sentences here, so they carry no country name.
function formatPhone(value: unknown): string | null {
  return typeof value === "string" && value
    ? (formatInternationalPhoneNumber(value) ?? value)
    : null;
}

/** Links WhatsApp by QR, then waits with the user for the first message to reach the agent. */
export function WhatsAppSetup(props: { controls: ChannelsProps; accountId: string }) {
  return (
    <Show
      when={props.controls.channels.whatsappLoginConnected === true}
      fallback={<WhatsAppLink controls={props.controls} />}
    >
      <WhatsAppFirstMessage controls={props.controls} accountId={props.accountId} />
    </Show>
  );
}

function WhatsAppLink(props: { controls: ChannelsProps }) {
  const channels = () => props.controls.channels;
  const qr = () => channels().whatsappLoginQrDataUrl;
  const busy = () => props.controls.mutationBusy?.whatsapp || channels().whatsappBusy;
  // The login owner clears the code once it expires or fails and keeps the reason.
  const ended = () => !qr() && !busy() && Boolean(channels().whatsappLoginMessage);
  return (
    <>
      <div class="whatsapp-link">
        <div class="whatsapp-link__code">
          <Show
            when={qr()}
            fallback={
              <div class="whatsapp-link__placeholder" aria-hidden="true">
                <Show when={!ended()}>
                  <span class="whatsapp-link__spinner" />
                </Show>
              </div>
            }
          >
            {(src) => <img src={src()} alt={t("channels.setup.whatsappQrAlt")} />}
          </Show>
        </div>
        <ol class="whatsapp-link__steps">
          <li>{t("channels.setup.whatsappStepOpen")}</li>
          <li>{t("channels.setup.whatsappStepLinkedDevices")}</li>
          <li>{t("channels.setup.whatsappStepScan")}</li>
        </ol>
      </div>
      <Switch>
        <Match when={ended()}>
          <div class="whatsapp-setup__status whatsapp-setup__status--ended" role="alert">
            <span>{t("channels.setup.whatsappCodeEnded")}</span>
            <span class="whatsapp-setup__detail">{channels().whatsappLoginMessage}</span>
          </div>
        </Match>
        <Match when={qr()}>
          <WaitingStatus label={t("channels.setup.whatsappWaitingScan")}>
            {t("channels.setup.whatsappCodeRefreshes")}
          </WaitingStatus>
        </Match>
        <Match when={true}>
          <WaitingStatus label={t("channels.setup.whatsappPreparingCode")} />
        </Match>
      </Switch>
      <openclaw-modal-actions class="channels-wizard__footer">
        <button type="button" class="btn" onClick={() => props.controls.wizardHost.close()}>
          {t("common.cancel")}
        </button>
        <Show when={ended()}>
          <button
            type="button"
            class="btn primary"
            onClick={() => void props.controls.onWhatsAppStart(true)}
          >
            {t("channels.setup.whatsappNewCode")}
          </button>
        </Show>
      </openclaw-modal-actions>
    </>
  );
}

function WaitingStatus(props: { label: string; children?: string }) {
  return (
    <div class="whatsapp-setup__status" role="status" aria-live="polite">
      <span class="whatsapp-setup__pulse" aria-hidden="true" />
      <span>{props.label}</span>
      <Show when={props.children}>
        <span class="whatsapp-setup__detail">{props.children}</span>
      </Show>
    </div>
  );
}

function WhatsAppFirstMessage(props: { controls: ChannelsProps; accountId: string }) {
  const status = createMemo(() =>
    asRecord(props.controls.channels.channelsSnapshot?.channels.whatsapp),
  );
  const phone = createMemo(() => formatPhone(asRecord(status()?.self)?.e164));
  const config = createMemo(() =>
    resolveEditableSnapshotConfig(props.controls.config.configSnapshot),
  );
  // Setup recorded whose phone this is; a separate number takes messages from other phones.
  const separate = createMemo(
    () => resolveChannelConfigValue(config(), "whatsapp")?.selfChatMode === false,
  );
  // With the default DM scope, WhatsApp chats continue the agent's main conversation.
  const sharesMainChat = createMemo(() => {
    const dmScope = asRecord(config()?.session)?.dmScope;
    return dmScope === undefined || dmScope === "main";
  });
  // Only a message admitted since this link connected counts; older ones belong to a past link.
  const received = createMemo(() => {
    const at = status()?.lastMessageAt;
    const connectedAt = status()?.lastConnectedAt;
    return typeof at === "number" && (typeof connectedAt !== "number" || at >= connectedAt);
  });
  const requests = createMemo(() =>
    separate()
      ? (props.controls.channels.pairingSnapshot?.requests ?? []).filter(
          (request) => request.channel === "whatsapp" && request.accountId === props.accountId,
        )
      : [],
  );
  const [allowed, setAllowed] = createSignal<string | null>(null);
  async function allow(request: ChannelsPairingRequest) {
    if (await props.controls.wizardHost.allowWhatsApp(request)) {
      setAllowed(formatPhone(request.senderId) ?? request.senderId);
    }
  }
  return (
    <>
      <div class="whatsapp-setup__linked">
        <span class="whatsapp-setup__check" aria-hidden="true">
          <Icon name="check" />
        </span>
        <div class="whatsapp-setup__linked-text">
          <span class="channels-wizard__message">{t("channels.setup.whatsappConnected")}</span>
          <Show when={phone()}>
            <span class="whatsapp-setup__detail">{phone()}</span>
          </Show>
        </div>
      </div>
      <Show
        when={received()}
        fallback={
          <>
            <FirstMessagePoll controls={props.controls} pairing={separate()} />
            <p class="channels-wizard__note">
              {separate()
                ? t("channels.setup.whatsappSayHiSeparate", {
                    phone: phone() ?? t("channels.setup.whatsappThisNumber"),
                  })
                : t("channels.setup.whatsappSayHiPersonal")}
            </p>
            <For each={requests()} keyed={(request) => request.requestId}>
              {(request) => (
                <div class="whatsapp-setup__request">
                  <span class="whatsapp-setup__request-text">
                    {t("channels.setup.whatsappRequest", {
                      sender: formatPhone(request().senderId) ?? request().senderId,
                    })}
                  </span>
                  <button
                    type="button"
                    class="btn btn--sm primary"
                    disabled={
                      Boolean(props.controls.channels.pairingBusy) ||
                      !props.controls.canManagePairing
                    }
                    onClick={() => void allow(request())}
                  >
                    {t("channels.setup.whatsappAllow")}
                  </button>
                </div>
              )}
            </For>
            <Show when={allowed()}>
              {(sender) => (
                <p class="channels-wizard__note" role="status">
                  {t("channels.setup.whatsappAllowed", { sender: sender() })}
                </p>
              )}
            </Show>
            <WaitingStatus label={t("channels.setup.whatsappWaitingMessage")} />
          </>
        }
      >
        <div class="whatsapp-setup__status whatsapp-setup__status--done" role="status">
          <span>{t("channels.setup.whatsappReceived")}</span>
          <span class="whatsapp-setup__detail">
            {t(
              sharesMainChat()
                ? "channels.setup.whatsappReceivedChat"
                : "channels.setup.whatsappReceivedWhatsApp",
            )}
          </span>
        </div>
      </Show>
      <openclaw-modal-actions class="channels-wizard__footer">
        <button
          type="button"
          class={["btn", { primary: !received() || !sharesMainChat() }]}
          onClick={() => props.controls.wizardHost.close()}
        >
          {t("channels.setup.done")}
        </button>
        <Show when={received() && sharesMainChat()}>
          <button
            type="button"
            class="btn primary"
            onClick={() => props.controls.wizardHost.openWhatsAppChat()}
          >
            {t("channels.setup.whatsappOpenChat")}
          </button>
        </Show>
      </openclaw-modal-actions>
    </>
  );
}

/** Mounted only while waiting, so polling ends with the first message or the dialog. */
function FirstMessagePoll(props: { controls: ChannelsProps; pairing: boolean }) {
  useVisiblePoll(
    FIRST_MESSAGE_POLL_MS,
    () => {
      props.controls.onRefresh(false);
      if (props.pairing) {
        props.controls.onPairingRefresh();
      }
    },
    { enabled: () => true },
  );
  return null;
}
