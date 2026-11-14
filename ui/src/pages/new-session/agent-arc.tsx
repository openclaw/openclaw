import { createEffect, createMemo, For, onSettled, Show, untrack } from "solid-js";
import type { AgentIdentityResult, GatewayAgentRow } from "../../api/types.ts";
import { AgentIdentityAvatar } from "../../components/solid/identity-avatar.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { normalizeAgentTargetLabel, resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createMediaQuerySource } from "../../lib/reactive/platform.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { resolveAssistantDisplayAvatar } from "../chat/components/chat-welcome.ts";
import { createAgentArcMotion, type AgentArcMotion } from "./agent-arc-motion.ts";
import * as catalog from "./catalog-target.ts";
import type { NewSessionPageOwner } from "./new-session-page-owner.ts";

registerNewSessionSetupEnglish();

export type AgentArcProps = {
  /** Agents in the Agents menu's order. */
  agents: readonly GatewayAgentRow[];
  agentId: string;
  identityById: Record<string, AgentIdentityResult>;
  disabled: boolean;
  onSelect: (agentId: string) => void;
};

/**
 * The new-session avatar with the other agents on an arc behind it: unfolded on hover with a
 * pointer, the nearest neighbours always beside it on touch. Choosing goes through the same
 * selection as the Agents menu.
 */
export function AgentArc(props: AgentArcProps) {
  let root: HTMLDivElement | undefined;
  let tip: HTMLSpanElement | undefined;
  const faces = new Map<string, HTMLButtonElement>();
  const touch = createMediaQuerySource("(hover: none)");
  const reducedMotion = createMediaQuerySource("(prefers-reduced-motion: reduce)");
  const entries = createMemo(() =>
    props.agents.map((agent) => {
      const id = normalizeAgentId(agent.id);
      const identity = props.identityById[agent.id];
      return {
        id,
        name: normalizeAgentTargetLabel(agent, identity),
        // The same resolution the welcome avatar uses, for every face.
        avatar: resolveAssistantDisplayAvatar(
          {
            currentAgentId: agent.id,
            assistantAvatar: resolveAgentTextAvatar(agent, identity),
            assistantAvatarUrl: resolveAgentAvatarUrl(agent, identity),
          },
          agent.id,
        ),
      };
    }),
  );
  const current = createMemo(() => normalizeAgentId(props.agentId));
  const currentIndex = () => entries().findIndex((entry) => entry.id === current());
  let motion: AgentArcMotion | undefined;
  onSettled(() => () => motion?.dispose());
  // Rebuild only when the roster or the input mode changes; names and avatars update in place.
  const layout = createMemo(() =>
    [
      touch.read() ? "touch" : "pointer",
      reducedMotion.read() ? "reduced" : "motion",
      ...entries().map((entry) => entry.id),
    ].join("\n"),
  );
  createEffect(layout, (key) => {
    const [mode, preference] = key.split("\n");
    const touchOnly = mode === "touch";
    const reduced = preference === "reduced";
    motion?.dispose();
    motion = undefined;
    const arc = root;
    if (!arc || !tip) {
      return;
    }
    arc.toggleAttribute("data-touch", touchOnly);
    motion = createAgentArcMotion({
      root: arc,
      tip,
      identity: () => arc.parentElement,
      touch: touchOnly,
      reducedMotion: reduced,
      disabled: () => untrack(() => props.disabled),
      name: (index) => untrack(entries)[index]?.name ?? "",
      labels: (index, centre) => {
        const name = untrack(entries)[index]?.name ?? "";
        return centre ? `${t("newSession.agent")}: ${name}` : t("newSession.switchAgent", { name });
      },
      pick: (index) => {
        const entry = untrack(entries)[index];
        if (entry && !untrack(() => props.disabled)) {
          props.onSelect(entry.id);
        }
      },
    });
    const elements = untrack(entries).flatMap((entry) => faces.get(entry.id) ?? []);
    motion.setFaces(elements, untrack(currentIndex));
  });
  createEffect(currentIndex, (index) => motion?.setCurrent(index));
  createEffect(
    () =>
      entries()
        .map((entry) => entry.name)
        .join("\n"),
    () => motion?.relabel(),
  );
  return (
    <div
      ref={(element) => (root = element)}
      class="agent-chat__welcome-avatar agent-arc"
      data-open="false"
    >
      <span class="agent-arc__zone" aria-hidden="true" />
      <For each={entries()} keyed={(entry) => entry.id}>
        {(entry) => (
          <button
            ref={(element) => faces.set(untrack(entry).id, element)}
            type="button"
            class="agent-arc__face"
            data-agent-id={entry().id}
            aria-haspopup={entry().id === current() ? "listbox" : undefined}
            tabindex={-1}
          >
            <AgentIdentityAvatar agent={entry().avatar} />
          </button>
        )}
      </For>
      <span class="agent-arc__hit" aria-hidden="true" />
      <span ref={(element) => (tip = element)} class="agent-arc__tip" aria-hidden="true" />
    </div>
  );
}

/** The draft's welcome avatar, with the other agents on an arc when the draft can switch agents. */
export function DraftAgentArc(props: { page: () => NewSessionPageOwner }) {
  const place = () => props.page().place;
  const submission = () => props.page().submission;
  const available = () =>
    !catalog.isTarget(props.page().data) &&
    place().agents().length > 1 &&
    place()
      .agents()
      .some((agent) => normalizeAgentId(agent.id) === normalizeAgentId(place().agentId));
  return (
    <Show when={available()}>
      <AgentArc
        agents={place().agents()}
        agentId={place().agentId}
        identityById={Object.fromEntries(
          place()
            .agents()
            .flatMap((agent) => {
              const identity = props.page().context?.agentIdentity.get(agent.id);
              return identity ? [[agent.id, identity]] : [];
            }),
        )}
        disabled={submission().submitting || Boolean(submission().pendingPlacement.sessionKey)}
        onSelect={(agentId) => place().selectAgentId(agentId)}
      />
    </Show>
  );
}
