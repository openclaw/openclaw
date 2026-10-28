import { createMemo, createSignal, Show } from "solid-js";
import { SettingsRow, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type {
  GitLabManagedIdentityView,
  GitLabManagedIdentityState,
} from "./gitlab-managed-identity.ts";
import { GitLabServerAuthorization } from "./gitlab-server-authorization.tsx";

/** Presents the actual selected/effective account from one managed-target owner. */
export function GitLabManagedIdentity(props: {
  identity: GitLabManagedIdentityState;
  readView?: () => GitLabManagedIdentityView;
  scope: "system" | "agent";
  mode?: "all" | "account" | "setup";
  title: string;
  description: string;
  setupOpen?: boolean;
  onOpenSetup?: () => void;
  onCloseSetup?: () => void;
  onViewAccount?: () => void;
}) {
  const projection = createMemo(() =>
    props.readView ? null : projectOwner(props.identity, (owner) => owner.view),
  );
  const view = createMemo(() => (props.readView ? props.readView() : projection()!.read()));
  const [localSetupOpen, setLocalSetupOpen] = createSignal(false);
  const status = () => {
    const current = view().status;
    return current?.configured ? current : null;
  };
  const identity = () =>
    status()?.selected ?? (props.scope === "agent" ? status()?.effective : null);
  const open = () => (props.onOpenSetup ? props.onOpenSetup() : setLocalSetupOpen(true));
  const close = () => (props.onCloseSetup ? props.onCloseSetup() : setLocalSetupOpen(false));
  const setupOpen = () => props.setupOpen ?? localSetupOpen();
  const locked = () => view().busy || view().loading;
  const label = () =>
    !identity()
      ? "No credentials"
      : identity()?.credentialState === "available"
        ? "Connected"
        : identity()?.refreshState === "reconnect_required" || identity()?.refreshState === "failed"
          ? "Reconnect required"
          : "Unavailable";
  return (
    <Show when={view().eligible && (status() || view().error)}>
      <Show when={props.mode !== "setup"}>
        <SettingsRow
          title={props.title}
          description={`${props.description}${
            props.scope === "agent" &&
            !status()?.selected &&
            status()?.effectiveSource === "system-configured"
              ? " Uses System GitLab."
              : ""
          }${identity()?.account ? ` @${identity()!.account!.login}.` : ""}`}
          control={
            <>
              <SettingsStatus
                kind={identity()?.credentialState === "available" ? "ok" : "muted"}
                label={label()}
              />
              <Show
                when={props.onViewAccount}
                fallback={
                  <Show when={view().canAdmin}>
                    <button type="button" class="btn btn--sm" disabled={locked()} onClick={open}>
                      {props.scope === "system" ? "Change System GitLab" : "Change agent GitLab"}
                    </button>
                  </Show>
                }
              >
                <button type="button" class="btn btn--sm" onClick={() => props.onViewAccount?.()}>
                  View agent account
                </button>
              </Show>
            </>
          }
        />
        <Show when={view().error}>
          <SettingsRow
            title="GitLab connection"
            description={view().error}
            role="alert"
            control={
              <button
                type="button"
                class="btn btn--sm"
                disabled={locked()}
                onClick={() => void props.identity.verify()}
              >
                Retry
              </button>
            }
          />
        </Show>
      </Show>
      <Show when={props.mode !== "account" && setupOpen() && view().canAdmin}>
        <GitLabServerAuthorization
          issuer={status()?.issuer}
          disabled={locked() || Boolean(view().pending)}
          title={props.scope === "system" ? "Connect System GitLab" : "Connect agent GitLab"}
          description="Authorize the account to use for this target. Your own GitLab connection is separate."
          onContinue={(serverUrl) => void props.identity.start(serverUrl)}
        />
        <Show when={view().pending}>
          <SettingsRow
            title="GitLab authorization"
            description="Approve access in GitLab. The returned Profile page completes this selected connection."
            control={
              <a
                class="btn btn--sm"
                href={view().pending!.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open GitLab sign-in
              </a>
            }
          />
          <SettingsRow
            title="Pending authorization"
            control={
              <button
                type="button"
                class="btn btn--sm"
                disabled={locked()}
                onClick={() => void props.identity.cancel()}
              >
                Cancel authorization
              </button>
            }
          />
        </Show>
        <Show when={status()?.selected}>
          <SettingsRow
            title={props.scope === "system" ? "Disconnect System GitLab" : "Use System GitLab"}
            description={
              props.scope === "system"
                ? "Remove this explicit system selection."
                : "Remove this agent override and use the explicit system selection."
            }
            control={
              <button
                type="button"
                class="btn btn--sm"
                disabled={locked()}
                onClick={() => void props.identity.inherit()}
              >
                {props.scope === "system" ? "Disconnect" : "Use System GitLab"}
              </button>
            }
          />
        </Show>
        <SettingsRow
          title="Only the selected connection changes."
          control={
            <button type="button" class="btn btn--sm" onClick={close}>
              Close
            </button>
          }
        />
      </Show>
    </Show>
  );
}
