import type { SkillsWorkshopUndoResult } from "@openclaw/gateway-protocol";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  onSettled,
  Show,
} from "solid-js";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/chat/skill-learned-notice.css";
import { normalizeAgentId } from "../../../lib/sessions/session-key.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

/** One review's changes, with Workshop links and one whole-review Undo operation. */
export function ChatSkillLearnedNotice(props: { notice?: SkillWorkshopChangeNotice }) {
  const context = useOptionalApplication();
  const gateway = context && projectGateway(context.gateway);
  return (
    <openclaw-chat-skill-learned-notice>
      <Show when={props.notice} keyed>
        {(notice) => {
          const [undone, setUndone] = createSignal(false);
          const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
          // A pending outcome must not hold the co-written Undoing affordance.
          const outcome = createMemo(() => attempt()?.result.then(() => null), {
            loadingValue: undefined,
          });
          const [pending, setPending] = createOptimistic(false);
          let inFlight = false;
          let disposed = false;
          onSettled(() => () => {
            disposed = true;
          });
          const runUndo = action(function* () {
            const snapshot = context?.gateway.snapshot;
            const client = snapshot?.phase === "connected" ? snapshot.client : null;
            if (
              !context ||
              !client ||
              inFlight ||
              undone() ||
              !canCallGatewayMethod(snapshot, "skills.workshop.undo", "operator.admin")
            ) {
              return;
            }
            inFlight = true;
            setPending(true);
            try {
              // "already-undone" also means the review's changes were successfully reverted.
              yield client.request<SkillsWorkshopUndoResult>("skills.workshop.undo", {
                agentId: notice.agentId,
                runId: notice.runId,
              });
              if (!disposed) {
                setUndone(context.gateway.snapshot.client === client);
              }
            } catch (error) {
              if (!disposed && context.gateway.snapshot.client === client) {
                throw error;
              }
            } finally {
              inFlight = false;
            }
          });
          const undo = () => {
            if (inFlight) {
              return;
            }
            const result = runUndo();
            // The keyed notice may retire before its error slot observes this attempt.
            void result.catch(() => {});
            setAttempt({ result });
          };
          const openSkill = (agentId: string, name: string) => {
            context?.agentSelection.set(normalizeAgentId(agentId));
            context?.navigate("skill-workshop", { search: `?skill=${encodeURIComponent(name)}` });
          };
          return (
            <div
              class={["chat-skill-notice", { "chat-skill-notice--undone": undone() }]}
              role="group"
              aria-label={t("chat.skillLearned.label")}
            >
              <div class="chat-skill-notice__line">
                <span class="chat-skill-notice__icon" aria-hidden="true">
                  <Icon name="lightbulb" />
                </span>
                <span class="chat-skill-notice__label">{t("chat.skillLearned.label")}</span>
                <For each={notice.skills}>
                  {(skill) => {
                    const verb = () => t(`chat.skillLearned.${skill.action}`);
                    const open = () => t("chat.skillLearned.open", { name: skill.name });
                    return (
                      <span class="chat-skill-notice__skill">
                        <span class="chat-skill-notice__sep" aria-hidden="true">
                          ·
                        </span>
                        {verb()}
                        <button
                          type="button"
                          class="chat-skill-notice__name"
                          title={skill.summary ? `${skill.summary}\n${open()}` : open()}
                          aria-label={`${verb()} ${skill.name}${skill.summary ? `: ${skill.summary}` : ""}. ${open()}`}
                          onClick={() => openSkill(notice.agentId, skill.name)}
                        >
                          {skill.name}
                        </button>
                      </span>
                    );
                  }}
                </For>
                <Show
                  when={undone()}
                  fallback={
                    <Show
                      when={canCallGatewayMethod(
                        gateway?.read().snapshot,
                        "skills.workshop.undo",
                        "operator.admin",
                      )}
                    >
                      <button
                        type="button"
                        class="chat-skill-notice__undo"
                        disabled={pending()}
                        aria-busy={pending() ? "true" : "false"}
                        onClick={undo}
                      >
                        <Show when={pending()} fallback={<Icon name="rotateCcw" />}>
                          <span class="btn__spinner" aria-hidden="true" />
                        </Show>
                        {pending() ? t("chat.skillLearned.undoing") : t("chat.skillLearned.undo")}
                      </button>
                    </Show>
                  }
                >
                  <span class="chat-skill-notice__done" role="status">
                    <Icon name="check" />
                    {t("chat.skillLearned.undone")}
                  </span>
                </Show>
              </div>
              <Show when={!pending()}>
                <Errored
                  fallback={(error) => (
                    <p class="chat-skill-notice__error" role="alert">
                      {t("chat.skillLearned.undoError", { error: formatUiError(error()) })}
                    </p>
                  )}
                >
                  {outcome()}
                </Errored>
              </Show>
            </div>
          );
        }}
      </Show>
    </openclaw-chat-skill-learned-notice>
  );
}
