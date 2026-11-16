import { createMemo, createSignal, For, onSettled, Show, useContext } from "solid-js";
import type { ControlUiAction, ControlUiRunFailure } from "../../../src/plugin-sdk/control-ui.js";
import { isIncognitoSessionKey } from "../../../src/shared/incognito-session-key.js";
import { ReportIssueLink } from "../components/report-issue-link.tsx";
import { Icon } from "../components/solid/icon.tsx";
import { formatUiError } from "../lib/format-error.ts";
import { resolveSafeExternalUrl } from "../lib/open-external-url.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { sharedPluginsProjection } from "../lib/reactive/shared-application-projections.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import { runControlUiPluginAction } from "./control-ui-actions.ts";
import type { ControlUiRegistration } from "./control-ui-capability.ts";

type FailureTarget = { sessionKey: string; agentId?: string; runFailure: ControlUiRunFailure };

/** Presentation of an already settled transcript failure; never starts an agent turn. */
export function PluginRunFailureActions(props: FailureTarget) {
  const app = useOptionalApplication();
  const runtime = app?.plugins ? sharedPluginsProjection(app.plugins) : undefined;
  const actions = createMemo(() =>
    isIncognitoSessionKey(props.sessionKey)
      ? []
      : (runtime
          ?.read()
          .registrations("actions")
          .flatMap((entry) => {
            if (entry.value.placement !== "run-failure") {
              return [];
            }
            try {
              const state = entry.value.resolve?.({
                sessionKey: props.sessionKey,
                agentId: props.agentId,
                runFailure: props.runFailure,
              });
              return state?.hidden ? [] : [{ entry, state }];
            } catch (error) {
              app?.plugins.reportError(entry.pluginId, error);
              return [];
            }
          }) ?? []),
  );
  return (
    <Show when={actions().length > 0} fallback={<ReportIssueLink />}>
      <For each={[JSON.stringify([props.sessionKey, props.agentId, props.runFailure.runId])]}>
        {() => (
          <For each={actions()} keyed={(action) => action.entry.signal}>
            {(action) => (
              <FailureAction
                entry={action().entry}
                state={action().state}
                sessionKey={props.sessionKey}
                agentId={props.agentId}
                runFailure={props.runFailure}
              />
            )}
          </For>
        )}
      </For>
    </Show>
  );
}

function FailureAction(
  props: FailureTarget & {
    entry: ControlUiRegistration<ControlUiAction>;
    state: ReturnType<NonNullable<ControlUiAction["resolve"]>> | undefined;
  },
) {
  const app = useOptionalApplication();
  const presented = useContext(ContentPresentation);
  const lifetime = new AbortController();
  onSettled(() => () => lifetime.abort());
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const links = createMemo(
    () =>
      props.state?.receipt?.links?.flatMap((link) => {
        const url = resolveSafeExternalUrl(link.url, window.location.href);
        return url ? [{ label: link.label, url }] : [];
      }) ?? [],
  );
  const run = async () => {
    if (!app || pending() || !presented()) {
      return;
    }
    const target = {
      sessionKey: props.sessionKey,
      agentId: props.agentId,
      runId: props.runFailure.runId,
    };
    const isCurrent = () =>
      !lifetime.signal.aborted &&
      presented() &&
      props.sessionKey === target.sessionKey &&
      props.agentId === target.agentId &&
      props.runFailure.runId === target.runId;
    setError(null);
    setPending(true);
    try {
      await runControlUiPluginAction({
        runtime: app.plugins,
        id: props.entry.key,
        placement: "run-failure",
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        runFailure: props.runFailure,
        signal: lifetime.signal,
        isCurrent,
      });
    } catch (failure) {
      if (isCurrent()) {
        setError(formatUiError(failure));
      }
    } finally {
      if (!lifetime.signal.aborted) {
        setPending(false);
      }
    }
  };
  return (
    <>
      <button
        type="button"
        class="btn btn--sm"
        disabled={pending() || props.state?.disabled}
        onClick={() => void run()}
      >
        <Show when={props.entry.panelIcon} fallback={<Icon name="plug" />}>
          {(icon) => <img class="chat-run-failure__plugin-icon" src={icon()} alt="" />}
        </Show>
        {props.state?.label ?? props.entry.value.label}
      </button>
      <Show when={error()}>
        <span class="chat-run-failure__receipt" role="alert">
          {error()}
        </span>
        <ReportIssueLink />
      </Show>
      <Show when={props.state?.receipt}>
        {(receipt) => (
          <div
            class="chat-run-failure__receipt"
            role="status"
            data-plugin-receipt={props.entry.pluginId}
          >
            <Show when={props.entry.panelIcon} fallback={<Icon name="plug" />}>
              {(icon) => <img class="chat-run-failure__plugin-icon" src={icon()} alt="" />}
            </Show>
            <span class="muted">
              {props.entry.pluginId} · {receipt().id}
            </span>
            <span>{receipt().text}</span>
            <For each={links()}>
              {(link) => (
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
              )}
            </For>
          </div>
        )}
      </Show>
    </>
  );
}
