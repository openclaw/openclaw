import { createMemo, For, onSettled, Show } from "solid-js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { RelativeTime } from "../../../components/relative-time.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatAutomationsEnglish } from "../../../i18n/locales/en-chat-automations.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSessionAutomationInventory } from "../../../lib/reactive/session-automation-inventory.ts";
import type { AutomationActivity } from "../chat-automation-grouping.ts";
import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import { MessageGroup } from "./chat-message-group-view.tsx";
import "./chat-automation-activity.css";

registerChatAutomationsEnglish();
registerChatMessageMetadataEnglish();

type FrameOptions = Parameters<typeof AgentRunFrame>[0]["options"];
export function ChatAutomationActivity(props: {
  item: AutomationActivity;
  options: FrameOptions;
  gateway?: ApplicationGateway;
  sessionKey: string;
  presented: boolean;
}) {
  let host!: HTMLDivElement;
  const inventory = projectSessionAutomationInventory();
  const sourceGateway = createMemo(() => props.gateway);
  const sessionKey = createMemo(() => props.sessionKey);
  const binding = createMemo(() => ({ gateway: sourceGateway(), key: sessionKey() }));
  const visible = () =>
    host.isConnected && props.presented && host.ownerDocument.visibilityState !== "hidden";
  function SourceLifetime(scope: { gateway?: ApplicationGateway; key: string }) {
    onSettled(() => {
      const gateway = scope.gateway;
      const key = scope.key;
      inventory.replaceSource({
        gateway,
        sessionKey: key,
        document: host.ownerDocument,
        isVisible: () => props.gateway === gateway && props.sessionKey === key && visible(),
      });
    });
    return null;
  }
  function PresentedLifetime() {
    onSettled(() => {
      inventory.activate();
      return () => inventory.park();
    });
    return null;
  }
  const job = createMemo(() =>
    inventory.read().cron.cronJobs.find((entry) => entry.id === props.item.jobId),
  );
  const latest = () => props.item.runs.at(-1)!;
  const label = () =>
    job()?.name.trim() ||
    latest().input.senderSession?.label ||
    t("chat.messages.forwardedAutomation");
  const expanded = () => props.options.isWorkExpanded(props.item.key);
  const status = () => {
    const current = inventory.read();
    if (!current.readable) {
      return undefined;
    }
    if (!current.cron.connected) {
      return t("chat.messages.automationOffline");
    }
    if (current.error || !job()) {
      return t("chat.messages.automationUnavailable");
    }
    const entry = job()!;
    if (entry.runningAtMs !== undefined) {
      return t("chat.messages.automationChecking");
    }
    if (entry.autoDisabled || entry.lastRunStatus === "error") {
      return t("chat.messages.automationAttention");
    }
    if (!entry.enabled) {
      return t("chat.messages.automationPaused");
    }
    return entry.nextRunAtMs != null
      ? t("chat.messages.automationScheduled")
      : t("chat.messages.automationIdle");
  };
  const nextCheck = () =>
    inventory.read().cron.connected &&
    !inventory.read().error &&
    job()?.enabled &&
    job()?.runningAtMs === undefined
      ? job()?.nextRunAtMs
      : undefined;
  return (
    <div
      ref={(element) => (host = element)}
      class="chat-group tool chat-group--turn-block"
      data-chat-row-key={props.item.key}
    >
      <For each={[binding()]}>{(scope) => <SourceLifetime {...scope} />}</For>
      <Show when={props.presented}>
        <PresentedLifetime />
      </Show>
      <div class="chat-group-messages">
        <details
          class="chat-automation-activity"
          prop:open={expanded()}
          onToggle={(event) => {
            if (event.currentTarget.open !== expanded()) {
              props.options.onToggleWork(props.item.key, expanded());
            }
          }}
        >
          <summary class="chat-inline-disclosure chat-automation-activity__summary">
            <span class="chat-automation-activity__icon" aria-hidden="true">
              <Icon name="clock" />
            </span>
            <span class="chat-automation-activity__label" title={label()}>
              {label()}
            </span>
            <span
              class="chat-automation-activity__status"
              title={t("chat.messages.automationCurrentStatus")}
            >
              <span aria-hidden="true">· </span>
              {status() ??
                t(
                  props.item.runs.length === 1
                    ? "chat.messages.automationCheck"
                    : "chat.messages.automationChecks",
                  { count: String(props.item.runs.length) },
                )}
              <Show when={nextCheck()}>
                {(timestamp) => (
                  <>
                    {" · "}
                    {t("chat.messages.automationNextCheck")}{" "}
                    <RelativeTime timestampMs={timestamp()} />
                  </>
                )}
              </Show>
            </span>
            <span class="chat-automation-activity__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </summary>
          <Show when={expanded()}>
            <div class="chat-automation-activity__body">
              <div class="chat-automation-activity__count">
                {t("chat.messages.automationLoadedChecks", {
                  count: String(props.item.runs.length),
                })}
              </div>
              <For each={props.item.runs} keyed={(run) => run.input.key}>
                {(run) => (
                  <>
                    <MessageGroup
                      group={run().input}
                      options={{
                        ...props.options.renderGroupOptions(run().input),
                        isToolMessageExpanded: () => true,
                      }}
                    />
                    <Show when={run().frame}>
                      {(frame) => <AgentRunFrame frame={frame()} options={props.options} />}
                    </Show>
                  </>
                )}
              </For>
            </div>
          </Show>
        </details>
      </div>
    </div>
  );
}
