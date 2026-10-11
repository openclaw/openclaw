import { For, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type {
  PluginCredentialDescriptor,
  PluginCredentialInspection,
  PluginsCredentialsInspectResult,
} from "../../../../packages/gateway-protocol/src/schema/plugin-credentials.ts";
import {
  isSecretRef,
  isValidSecretRef,
  type SecretRef,
} from "../../../../src/secrets/ref-contract.ts";
import type { ConfigNodeRenderParams } from "../../components/config-form.node.shared.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/modal-dialog.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import "./credential-editor.css";

registerPluginManagementEnglish();
const credentialReferenceParts = ["provider", "id"] as const;
const credentialSources = ["env", "file", "exec", "store"] as const;

export type PluginCredentialEditorContext = {
  pluginId: string;
  baseHash: string | null;
  gateway: Pick<GatewayPageController, "capture" | "isCurrent" | "epoch" | "connected">;
  canInspect: boolean;
  saveError?: string | null;
  /** Adapter stages through field.onPatch and awaits that exact config-owner write. */
  onCommit: (path: Array<string | number>, value: unknown) => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
};
type CredentialField = Pick<ConfigNodeRenderParams, "path" | "value" | "disabled"> & {
  descriptionId?: string;
};

export type PluginCredentialEditorProps = {
  field: CredentialField;
  descriptor: PluginCredentialDescriptor;
  context: PluginCredentialEditorContext;
};

function PluginCredentialEditorContent(props: PluginCredentialEditorProps) {
  const [inspection, setInspection] = createSignal<PluginCredentialInspection | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [reference, setReference] = createSignal<SecretRef>({
    source: "env",
    provider: "default",
    id: "",
  });
  const [literal, setLiteral] = createSignal("");
  const [revealed, setRevealed] = createSignal(false);
  const [operation, setOperation] = createSignal<"save" | "discard">();
  const saving = () => operation() === "save";
  const cancelling = () => operation() === "discard";
  let referenceSubmitted = false;
  let referenceTrigger: HTMLElement | null = null;
  let generation = 0;
  let connection: GatewayConnectionScope | null = null;
  let active = true;
  let pending = false;

  createEffect(
    () => {
      const { pluginId, baseHash, gateway, canInspect } = props.context;
      const field = JSON.stringify([pluginId, props.field.path]);
      return {
        field,
        gateway,
        canInspect,
        identity: JSON.stringify([field, baseHash, gateway.epoch, canInspect]),
      };
    },
    (next, previous) => {
      if (next.identity === previous?.identity && next.gateway === previous?.gateway) {
        return;
      }
      const sourceChanged =
        next.gateway !== previous?.gateway ||
        next.field !== previous?.field ||
        !next.canInspect ||
        (connection && !next.gateway.isCurrent(connection));
      const wasOpen = untrack(dialogOpen);
      setRevealed(false);
      // Other settings can advance the revision before this field's blur commit.
      // Only retiring the field or connection may discard its uncommitted key.
      if (sourceChanged) {
        setLiteral("");
        setDialogOpen(false);
        pending = false;
        setOperation(undefined);
        referenceSubmitted = false;
        setReference({ source: "env", provider: "default", id: "" });
      }
      setInspection(null);
      generation++;
      if (wasOpen && !untrack(saving) && !sourceChanged) {
        setError(untrack(() => t("pluginsPage.credentials.stale")));
        setLoading(false);
        return;
      }
      void untrack(inspect);
    },
  );

  onCleanup(() => {
    active = false;
    generation++;
    referenceSubmitted = false;
    referenceTrigger = null;
  });

  async function inspect(reveal = false) {
    const { gateway, pluginId, baseHash, canInspect } = props.context;
    const capturedConnection = gateway.capture();
    const requestGeneration = ++generation;
    connection = capturedConnection;
    setError("");
    setLoading(false);
    if (!canInspect || !capturedConnection || !baseHash) {
      return;
    }
    setLoading(true);
    try {
      const result = await capturedConnection.client.request<PluginsCredentialsInspectResult>(
        "plugins.credentials.inspect",
        { pluginId, path: props.field.path, baseHash, ...(reveal ? { reveal: true } : {}) },
      );
      if (requestGeneration !== generation || !gateway.isCurrent(capturedConnection)) {
        return;
      }
      if (result.baseHash !== props.context.baseHash) {
        setError(t("pluginsPage.credentials.stale"));
        return;
      }
      setInspection(
        result.credential.kind === "literal" && !reveal ? { kind: "literal" } : result.credential,
      );
      setRevealed(
        reveal && result.credential.kind === "literal" && result.credential.value !== undefined,
      );
      if (dialogOpen() && result.credential.kind === "reference") {
        setReference({ ...result.credential.ref });
      }
    } catch (cause) {
      if (requestGeneration === generation && gateway.isCurrent(capturedConnection)) {
        setError(formatUiError(cause));
      }
    } finally {
      if (requestGeneration === generation && gateway.isCurrent(capturedConnection)) {
        setLoading(false);
      }
    }
  }

  function toggleReveal() {
    if (revealed()) {
      setRevealed(false);
      if (inspection()?.kind === "literal") {
        setInspection({ kind: "literal" });
      }
    } else if (literal()) {
      setRevealed(true);
    } else {
      void inspect(true);
    }
  }

  function openReference(event: MouseEvent) {
    referenceTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    referenceSubmitted = false;
    const value = inspection();
    setReference(
      value?.kind === "reference"
        ? { ...value.ref }
        : { source: "env", provider: "default", id: "" },
    );
    setDialogOpen(true);
  }

  function enteredLiteral(input: HTMLInputElement) {
    // Native blur can precede Solid's signal commit. Revealing a stored key is not an edit.
    return literal() || input.value !== literalValue() ? input.value : "";
  }

  async function patch(value: string | SecretRef) {
    if (
      props.field.disabled ||
      pending ||
      !props.context.canInspect ||
      !connection ||
      !props.context.gateway.isCurrent(connection)
    ) {
      return;
    }
    return commitOrDiscardReference(value);
  }

  async function cancelReference() {
    if (pending) {
      return;
    }
    if (!referenceSubmitted) {
      setDialogOpen(false);
      return;
    }
    return commitOrDiscardReference(undefined);
  }

  async function commitOrDiscardReference(value: string | SecretRef | undefined) {
    const gateway = props.context.gateway;
    const capturedConnection = connection;
    const owner = JSON.stringify([props.context.pluginId, props.field.path]);
    const current = () =>
      active &&
      props.context.gateway === gateway &&
      capturedConnection !== null &&
      gateway.isCurrent(capturedConnection) &&
      JSON.stringify([props.context.pluginId, props.field.path]) === owner;
    // Admission is synchronous; Solid publishes the pending presentation after this task.
    pending = true;
    setOperation(value === undefined ? "discard" : "save");
    if (value !== undefined) {
      referenceSubmitted ||= dialogOpen();
      setError("");
    }
    try {
      const acknowledged = await (value === undefined
        ? props.context.onDiscard()
        : props.context.onCommit(props.field.path, value));
      if (!current()) {
        return;
      }
      if (acknowledged) {
        referenceSubmitted = false;
        setDialogOpen(false);
        if (value !== undefined) {
          setLiteral("");
        }
        await inspect();
      } else {
        setError(
          props.context.saveError ||
            t(
              value === undefined
                ? "configView.discardUnconfirmed"
                : "pluginsPage.credentials.saveFailed",
            ),
        );
      }
    } catch (cause) {
      if (current()) {
        setError(formatUiError(cause));
      }
    } finally {
      if (current()) {
        pending = false;
        setOperation(undefined);
      }
    }
  }

  const environment = () => {
    const credential = inspection();
    return credential?.kind === "environment" ? credential.envVar : null;
  };
  const blocked = () =>
    props.field.disabled || loading() || saving() || cancelling() || !inspection();
  const failure = () => error() || props.context.saveError;
  const configured = () =>
    props.field.value === REDACTED_SENTINEL || inspection()?.kind === "literal";
  const isReference = () => inspection()?.kind === "reference" || isSecretRef(props.field.value);
  const disabled = () =>
    props.field.disabled ||
    saving() ||
    !props.context.canInspect ||
    !props.context.gateway.connected ||
    !props.context.baseHash;
  const referenceSource = () => {
    const credential = inspection();
    return credential?.kind === "reference"
      ? credential.ref.source
      : isSecretRef(props.field.value)
        ? props.field.value.source
        : "";
  };
  const referenceId = () => {
    const credential = inspection();
    return credential?.kind === "reference" ? credential.ref.id : undefined;
  };
  const literalValue = () => {
    const credential = inspection();
    return (
      literal() || (revealed() && credential?.kind === "literal" ? (credential.value ?? "") : "")
    );
  };
  const unresolved = () => {
    const credential = inspection();
    return credential?.kind === "reference" && credential.unresolved;
  };

  return (
    <div class="plugin-credential">
      {isReference() || environment() ? (
        <div class="plugin-credential__reference">
          <span>
            {environment()
              ? t("pluginsPage.credentials.environment", { name: environment()! })
              : t("pluginsPage.credentials.fromSource", { source: referenceSource() })}
          </span>
          {referenceId() !== undefined ? <code>{referenceId()}</code> : null}
          <button
            class="btn btn--sm"
            aria-label={`${t(environment() ? "pluginsPage.credentials.viewSource" : "pluginsPage.credentials.editReference")}: ${props.descriptor.label}`}
            aria-describedby={props.field.descriptionId}
            disabled={loading() || !inspection() || !props.context.canInspect}
            onClick={openReference}
          >
            {t(
              environment()
                ? "pluginsPage.credentials.viewSource"
                : "pluginsPage.credentials.editReference",
            )}
          </button>
        </div>
      ) : (
        <>
          <div
            class="plugin-credential__input settings-secret"
            onFocusOut={(event) => {
              if (
                event.relatedTarget instanceof Element &&
                event.relatedTarget.closest(".plugin-credential__input") === event.currentTarget
              ) {
                return;
              }
              const input = event.currentTarget.querySelector("input");
              const value = input ? enteredLiteral(input) : "";
              if (value) {
                void patch(value);
              }
            }}
          >
            <input
              class="settings-input"
              aria-label={props.descriptor.label}
              aria-describedby={props.field.descriptionId}
              autocomplete="off"
              spellcheck="false"
              type={revealed() ? "text" : "password"}
              value={literalValue()}
              placeholder={
                configured()
                  ? t("pluginsPage.credentials.stored")
                  : (props.descriptor.placeholder ?? "")
              }
              disabled={disabled()}
              onInput={(event) => setLiteral(event.currentTarget.value)}
              onKeyDown={(event) => {
                const value = enteredLiteral(event.currentTarget);
                if (event.key === "Enter" && value) {
                  event.preventDefault();
                  void patch(value);
                }
              }}
            />
            <button
              class="settings-secret__toggle"
              type="button"
              aria-label={`${t(revealed() ? "pluginsPage.credentials.hide" : "pluginsPage.credentials.reveal")}: ${props.descriptor.label}`}
              aria-pressed={revealed() ? "true" : "false"}
              disabled={disabled() || loading() || (!literal() && inspection()?.kind !== "literal")}
              onClick={toggleReveal}
            >
              <Icon name={revealed() ? "eyeOff" : "eye"} />
            </button>
          </div>
          <div class="plugin-credential__links">
            {props.descriptor.signupUrl ? (
              <a href={props.descriptor.signupUrl} target="_blank" rel="noopener noreferrer">
                {t("pluginsPage.credentials.signup")}
                <Icon name="externalLink" />
              </a>
            ) : null}
            <button
              class="btn btn--ghost btn--sm"
              aria-label={`${t("pluginsPage.credentials.useReference")}: ${props.descriptor.label}`}
              aria-describedby={props.field.descriptionId}
              disabled={disabled() || loading() || !inspection() || !props.context.canInspect}
              onClick={openReference}
            >
              {t("pluginsPage.credentials.useReference")}
            </button>
          </div>
          {configured() ? <small>{t("pluginsPage.credentials.replace")}</small> : null}
        </>
      )}
      {loading() ? (
        <span role="status" class="muted">
          {t("common.loading")}
        </span>
      ) : null}
      {inspection()?.kind === "invalid" ? (
        <span role="alert">{t("pluginsPage.credentials.invalidStored")}</span>
      ) : null}
      {!dialogOpen() && failure() ? (
        <div role="alert">
          {failure()}
          <button
            class="btn btn--sm"
            onClick={() => void (literal() ? patch(literal()) : inspect())}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}
      {dialogOpen() ? (
        <openclaw-modal-dialog
          ref={(dialog) => dialog.setReturnFocusTarget(referenceTrigger)}
          label={`${t("pluginsPage.credentials.referenceTitle")}: ${props.descriptor.label}`}
          onModal-cancel={(event: Event) => {
            event.preventDefault();
            void cancelReference();
          }}
        >
          <section class="plugin-credential__dialog">
            <h2>{t("pluginsPage.credentials.referenceTitle")}</h2>
            {environment() ? (
              <p>{t("pluginsPage.credentials.environmentHelp", { name: environment()! })}</p>
            ) : (
              <>
                <p>{t("pluginsPage.credentials.referenceHelp")}</p>
                <label>
                  {t("pluginsPage.credentials.source")}
                  <select
                    autofocus
                    class="settings-input"
                    aria-label={t("pluginsPage.credentials.source")}
                    value={reference().source}
                    disabled={blocked()}
                    onChange={(event) => {
                      const source = credentialSources.find(
                        (entry) => entry === event.currentTarget.value,
                      );
                      if (source) {
                        setReference({ ...reference(), source });
                      }
                    }}
                  >
                    <For each={credentialSources}>
                      {(source) => (
                        <option value={source} selected={source === reference().source}>
                          {t(`pluginsPage.credentials.sources.${source}`)}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <For each={credentialReferenceParts}>
                  {(key) => (
                    <label>
                      {t(`pluginsPage.credentials.${key === "id" ? "identifier" : key}`)}
                      <input
                        class="settings-input"
                        value={reference()[key]}
                        disabled={blocked()}
                        onInput={(event) =>
                          setReference({ ...reference(), [key]: event.currentTarget.value })
                        }
                      />
                    </label>
                  )}
                </For>
                <p class="muted">{t(`pluginsPage.credentials.help.${reference().source}`)}</p>
                {unresolved() ? (
                  <p class="callout warn">{t("pluginsPage.credentials.unresolved")}</p>
                ) : null}
              </>
            )}
            {failure() ? (
              <p role="alert" class="callout danger">
                {failure()}
              </p>
            ) : null}
            <footer>
              <button
                class="btn"
                disabled={saving() || cancelling()}
                onClick={() => void cancelReference()}
              >
                {t("common.cancel")}
              </button>
              {!inspection() && !loading() ? (
                <button class="btn" onClick={() => void inspect()}>
                  {t("common.retry")}
                </button>
              ) : null}
              {!environment() ? (
                <button
                  class="btn primary"
                  disabled={blocked() || !isValidSecretRef(reference())}
                  onClick={() => void patch({ ...reference() })}
                >
                  {saving() ? t("common.saving") : t("common.save")}
                </button>
              ) : null}
            </footer>
          </section>
        </openclaw-modal-dialog>
      ) : null}
    </div>
  );
}

export const PluginCredentialEditor = defineSolidBridge<Partial<PluginCredentialEditorProps>>(
  "openclaw-plugin-credential-editor",
  (props) => (
    <>
      {props.field && props.descriptor && props.context ? (
        <PluginCredentialEditorContent
          field={props.field}
          descriptor={props.descriptor}
          context={props.context}
        />
      ) : null}
    </>
  ),
  {
    properties: {
      field: { default: undefined, attribute: false },
      descriptor: { default: undefined, attribute: false },
      context: { default: undefined, attribute: false },
    },
  },
);
