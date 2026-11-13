import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  createStore,
  Errored,
  For,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import { shellEscapeBackslash } from "../../../src/shared/shell-quote.js";
import type { ToolsEffectiveResult } from "../api/types.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { registerMcpEnglish } from "../i18n/locales/en-mcp.ts";
import { resolveEditableSnapshotConfig } from "../lib/config/config-state-model.ts";
import {
  resolveReadMcpServerRuntime,
  type McpServerRuntime,
  type McpToolsRead,
} from "../lib/config/mcp-server-status.ts";
import {
  buildAddMcpServerPatch,
  buildRemoveMcpServerPatch,
  buildToggleMcpServerPatch,
  MCP_SERVER_NAME_PATTERN,
  parseMcpTarget,
  patchMcpServers,
  summarizeMcpServers,
  type McpServerSummary,
  type McpServersPatchBuildResult,
} from "../lib/config/mcp-servers.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";
import type { McpServerForm } from "./mcp-server-form.ts";
import { McpServersForm } from "./mcp-servers-form.tsx";
import { CopyButton } from "./solid/copy-button.tsx";
import { Icon } from "./solid/icon.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";
import {
  DocsLink,
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsSection,
  SettingsStatus,
  SettingsToggle,
} from "./solid/settings-ui.tsx";
import { createWizardLogin, WizardLogin } from "./wizard-login-controller.tsx";
import "../styles/exec-approval-card.css";

registerMcpEnglish();

export type McpServerEditorRenderer = (
  server: McpServerSummary,
  onRenamed: (name: string) => void,
) => JSX.Element;

type McpServersCardProps = { docsUrl: string; renderEditor?: McpServerEditorRenderer };
type McpServerMessage = { kind: "error" | "success"; text: string };

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : shellEscapeBackslash(value);
}

function tlsLabel(tls: McpServerSummary["tls"]): string | null {
  switch (tls) {
    case "verify-off":
      return t("mcpPage.tlsVerifyOff");
    case "mtls":
      return t("mcpPage.mtls");
    default:
      return null;
  }
}

type SavedConfigSnapshot = Parameters<typeof resolveEditableSnapshotConfig>[0];

function savedServers(snapshot: SavedConfigSnapshot): Readonly<Record<string, unknown>> {
  const mcp = asNullableRecord(resolveEditableSnapshotConfig(snapshot)?.mcp);
  return asNullableRecord(mcp?.servers) ?? {};
}

function McpServersHelp() {
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  let popover!: PopoverHandle;
  return (
    <span class="settings-section__docs">
      <openclaw-tooltip prop:content={t("mcpPage.serversHelp")}>
        <button
          ref={setTrigger}
          type="button"
          class="settings-section__help-button"
          aria-label={t("mcpPage.serversHelp")}
          aria-controls="mcp-servers-help"
          aria-haspopup="dialog"
          onClick={() => popover.overlay.request(!popover.overlay.open)}
        >
          <span aria-hidden="true">
            <Icon name="circleQuestionMark" />
          </span>
        </button>
      </openclaw-tooltip>
      <Show when={trigger()}>
        {(anchor) => (
          <Popover
            ref={(handle) => (popover = handle)}
            id="mcp-servers-help"
            label={t("mcpPage.serversHelp")}
            class="settings-section__help-popover"
            anchor={anchor()}
            placement="bottom-end"
          >
            <div class="settings-section__help-panel">
              <p>{t("mcpPage.runtimeHint")}</p>
            </div>
          </Popover>
        )}
      </Show>
    </span>
  );
}

/**
 * What the current session already knows, in words that claim no more than that.
 * There is no per-server health check, so only a Gateway diagnostic reads as failing.
 */
function RowStatus(props: { server: McpServerSummary; runtime: McpServerRuntime }) {
  return (
    <Show when={props.server.enabled}>
      <Show when={props.runtime.kind === "connected"}>
        <SettingsStatus kind="ok" label={t("mcpServers.statusToolsListed")} />
      </Show>
      <Show when={props.runtime.kind === "failing"}>
        <SettingsStatus kind="danger" label={t("mcpServers.statusFailing")} />
      </Show>
      <Show when={props.runtime.kind === "no-tools"}>
        <SettingsStatus kind="warn" label={t("mcpServers.statusNoTools")} />
      </Show>
      <Show when={props.runtime.kind === "pending"}>
        <SettingsStatus kind="muted" dot={false} label={t("mcpServers.statusPending")} />
      </Show>
    </Show>
  );
}

function McpServerTools(props: { runtime: McpServerRuntime }) {
  return (
    <Show when={props.runtime.tools.length > 0}>
      <section class="mcp-server-tools">
        <h3 class="mcp-server-row__label">{t("mcpServers.tools")}</h3>
        <ul class="mcp-server-tools__list">
          <For each={props.runtime.tools} keyed={(tool) => tool.id}>
            {(tool) => (
              <li>
                <code>{tool().label?.trim() || tool().mcpToolName}</code>
                <Show when={tool().description}>
                  <span class="settings-row__desc">{tool().description}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

function McpServerNote(props: {
  server: McpServerSummary;
  runtime: McpServerRuntime;
  canSignIn: boolean;
  disabled: boolean;
  onSignIn: () => void;
}) {
  const note = () => {
    if (props.server.signIn === "profile") {
      return t("mcpServers.profileSignIn");
    }
    if (props.server.signIn === "requester") {
      return t("mcpServers.requesterSignIn");
    }
    if (!props.server.enabled) {
      return null;
    }
    switch (props.runtime.kind) {
      case "failing":
        return props.runtime.message;
      case "no-tools":
        return t(props.canSignIn ? "mcpServers.noToolsSignInHint" : "mcpServers.noToolsHint");
      case "pending":
        return t(props.canSignIn ? "mcpServers.signInHint" : "mcpServers.pendingHint");
      default:
        return props.canSignIn ? t("mcpServers.signInHint") : null;
    }
  };
  return (
    <Show when={note()}>
      {(text) => (
        <div class="mcp-server-row__note">
          <span
            class={[
              "settings-row__desc",
              { "mcp-server-row__note-error": props.runtime.kind === "failing" },
            ]}
          >
            {text()}
          </span>
          <Show when={props.canSignIn}>
            <button
              type="button"
              class="btn btn--sm"
              aria-label={t("mcpServers.signInNamed", { name: props.server.name })}
              disabled={props.disabled}
              onClick={() => props.onSignIn()}
            >
              {t("mcpServers.signIn")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

function McpServerCommand(props: { server: McpServerSummary }) {
  const command = () =>
    `openclaw mcp ${props.server.auth === "oauth" ? "login" : "probe"} ${quoteShellArg(props.server.name)}`;
  return (
    <Show when={props.server.signIn !== "profile" && props.server.signIn !== "requester"}>
      <div class="mcp-command">
        <code>{command()}</code>
        <CopyButton text={command()} idleLabel={t("common.copy")} iconFeedback />
      </div>
    </Show>
  );
}

function McpServerRow(props: {
  server: McpServerSummary;
  runtime: McpServerRuntime;
  open: boolean;
  disabled: boolean;
  saving: boolean;
  blockedReason: string | null;
  canSignIn: boolean;
  editor?: JSX.Element;
  onToggleOpen: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const detailId = () => `mcp-server-detail-${props.server.name.replace(/[^a-z0-9-]/giu, "-")}`;
  const facts = () =>
    [
      props.server.toolFilter ? t("mcpPage.toolFilter") : null,
      props.server.parallel ? t("mcpPage.parallel") : null,
      tlsLabel(props.server.tls),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <div
      class={[
        "mcp-server-row",
        { "mcp-server-row--open": props.open, "mcp-server-row--off": !props.server.enabled },
      ]}
      data-mcp-name={props.server.name}
    >
      <div class="mcp-server-row__head">
        <button
          type="button"
          class="mcp-server-row__summary"
          aria-expanded={props.open ? "true" : "false"}
          aria-controls={detailId()}
          onClick={() => props.onToggleOpen()}
        >
          <span class="mcp-server-row__name">{props.server.name}</span>
          <span class="mcp-server-row__status">
            <RowStatus server={props.server} runtime={props.runtime} />
          </span>
          <span class="mcp-server-row__target" title={props.server.target}>
            {props.server.target || t("mcpServers.missingTransport")}
          </span>
          <Icon name="chevronDown" class="mcp-server-row__chevron" />
        </button>
        <span title={props.blockedReason ?? undefined}>
          <SettingsToggle
            ariaLabel={props.server.name}
            checked={props.server.enabled}
            disabled={props.blockedReason !== null}
            saving={props.saving}
            // The config snapshot decides the position, so a refused write never lies.
            onChange={(enabled) => {
              props.onToggleEnabled(enabled);
              return false;
            }}
          />
        </span>
      </div>
      <Show when={props.open}>
        <div class="mcp-server-row__detail" id={detailId()}>
          <span class="settings-row__desc mcp-server-row__facts">{facts()}</span>
          <McpServerNote
            server={props.server}
            runtime={props.runtime}
            canSignIn={props.canSignIn}
            disabled={props.disabled}
            onSignIn={props.onSignIn}
          />
          <McpServerTools runtime={props.runtime} />
          {props.editor}
          <div class="mcp-server-row__footer">
            <button
              type="button"
              class="btn btn--sm btn--ghost danger"
              aria-label={t("mcpServers.removeNamed", { name: props.server.name })}
              title={props.blockedReason ?? ""}
              disabled={props.disabled}
              onClick={() => props.onRemove()}
            >
              {t("common.remove")}
            </button>
            <McpServerCommand server={props.server} />
          </div>
        </div>
      </Show>
    </div>
  );
}

export function McpServersCard(props: McpServersCardProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = projectOwner(context.runtimeConfig, (source) => source.state);
  const [view, setView] = createStore<{
    message: McpServerMessage | null;
    formOpen: boolean;
    formError: string | null;
    expanded: string | null;
  }>({ message: null, formOpen: false, formError: null, expanded: null });
  const [busy, setBusy] = createOptimistic(false);
  const [toolsRead, setToolsRead] = createSignal<McpToolsRead | null>(null);
  // Admission must be synchronous even before Solid publishes the busy state.
  let mutationPending = false;
  let active = true;
  let toolsReadId = 0;
  let toolsReadKey: string | null = null;
  let addNameInput: HTMLInputElement | undefined;
  const login = createWizardLogin({
    getClient: () => context.gateway.snapshot.client ?? null,
    getAgentId: () => null,
    onClose: () => login.reset(),
    requestFailedMessage: () => t("mcpServers.signInFailed"),
    sessionExpiredMessage: () => t("mcpServers.signInExpired"),
  });
  const initialLoad = context.runtimeConfig.ensureLoaded();
  const [completion, setCompletion] = createSignal<Promise<void> | undefined>(initialLoad);
  const completed = createMemo(() => completion()?.then(() => null) ?? null);
  // The selected outcome owns feedback; a retired read cannot replace a later command.
  void initialLoad.catch(() => {});
  // A quiet read of what the current session already knows. A failure here only
  // means there is nothing to report, so it clears the status instead of alerting.
  const readEffectiveTools = async () => {
    const snapshot = context.gateway.snapshot;
    const client = snapshot.client;
    const sessionKey = snapshot.sessionKey?.trim();
    const savedConfig = context.runtimeConfig.state.configSnapshot;
    if (
      !savedConfig ||
      !client ||
      !sessionKey ||
      !canCallGatewayMethod(snapshot, "tools.effective", "operator.read")
    ) {
      toolsReadId++;
      toolsReadKey = null;
      setToolsRead(null);
      return;
    }
    // A read can hold the Gateway's main thread for seconds, most of all just after a save
    // reloads MCP, so it happens once per connection and session rather than after each edit.
    const key = JSON.stringify([snapshot.hello?.server?.connId, sessionKey]);
    if (key === toolsReadKey) {
      return;
    }
    toolsReadKey = key;
    setToolsRead(null);
    const read = ++toolsReadId;
    const servers = savedServers(savedConfig);
    try {
      const result = await client.request<ToolsEffectiveResult>("tools.effective", { sessionKey });
      if (active && read === toolsReadId) {
        setToolsRead({ result, servers });
      }
    } catch {
      if (active && read === toolsReadId) {
        setToolsRead(null);
      }
    }
  };
  onSettled(() => {
    let hello = context.gateway.snapshot.hello;
    // Retire sign-in with its transport or agent selection before the next interaction can reuse it.
    const stopGateway = context.gateway.subscribe((snapshot) => {
      if (snapshot.hello !== hello) {
        hello = snapshot.hello;
        login.reset();
      }
      void readEffectiveTools();
    });
    const stopConfig = context.runtimeConfig.subscribe(() => void readEffectiveTools());
    const stopSelection = context.agentSelection.subscribe(() => login.reset());
    void readEffectiveTools();
    return () => {
      active = false;
      stopGateway();
      stopConfig();
      stopSelection();
    };
  });

  const mutationBlockedReason = (): string | null => {
    const snapshot = gateway.read().snapshot;
    if (snapshot.phase !== "connected") {
      return t("mcpServers.connectRequired");
    }
    if (!hasOperatorAdminAccess(snapshot.hello?.auth ?? null)) {
      return t("mcpServers.adminRequired");
    }
    return null;
  };
  const canMutate = () => mutationBlockedReason() === null && login.state().phase === "idle";
  const canSignIn = (server: McpServerSummary) =>
    server.enabled &&
    server.signIn === "operator" &&
    canCallGatewayMethod(gateway.read().snapshot, "mcp.authLogin", "operator.admin");
  const signIn = (server: McpServerSummary) => {
    if (
      mutationPending ||
      !canMutate() ||
      !server.enabled ||
      server.signIn !== "operator" ||
      !canCallGatewayMethod(context.gateway.snapshot, "mcp.authLogin", "operator.admin")
    ) {
      return;
    }
    setCompletion(undefined);
    setView((draft) => {
      draft.message = null;
    });
    login.runner.prepareSignIn("oauth", server.name);
    void login.runner.startMcpLogin(server.name);
  };
  const performMutation = action(function* (mutate: () => Promise<void>) {
    setBusy(true);
    yield mutate();
  });
  const mutate = async (options: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
    successText: string;
    /** Report the failure beside the control that asked, instead of above the list. */
    onError?: (message: string) => void;
  }): Promise<boolean> => {
    if (!active || !canMutate() || mutationPending) {
      return false;
    }
    mutationPending = true;
    setView((draft) => {
      draft.message = null;
    });
    const result = performMutation(() => patchMcpServers(context.runtimeConfig, options));
    if (!options.onError) {
      void setCompletion(result);
    }
    try {
      await result;
      setView((draft) => {
        draft.message = { kind: "success", text: options.successText };
      });
      return true;
    } catch (error) {
      options.onError?.(formatUiError(error));
      return false;
    } finally {
      mutationPending = false;
    }
  };
  const setFormError = (text: string | null) =>
    setView((draft) => {
      draft.formError = text;
    });
  const addServer = async (form: McpServerForm) => {
    if (!MCP_SERVER_NAME_PATTERN.test(form.name)) {
      setFormError(t("mcpServers.nameInvalid"));
      return;
    }
    const target = parseMcpTarget(form.target, form.transport);
    if (!target) {
      setFormError(t("mcpServers.targetInvalid"));
      return;
    }
    setFormError(null);
    if (
      await mutate({
        buildPatch: (servers) => buildAddMcpServerPatch(servers, form.name, target),
        note: `mcp settings: add server ${form.name}`,
        successText: t("mcpServers.addedSuccess", { name: form.name }),
        onError: setFormError,
      })
    ) {
      setView((draft) => {
        draft.formOpen = false;
      });
    }
  };
  const toggleServer = (name: string, enabled: boolean) =>
    mutate({
      buildPatch: (servers) => buildToggleMcpServerPatch(servers, name, enabled),
      note: `mcp settings: ${enabled ? "enable" : "disable"} server ${name}`,
      successText: t(enabled ? "mcpServers.enabledSuccess" : "mcpServers.disabledSuccess", {
        name,
      }),
    });
  const removeServer = (name: string) => {
    if (!active || !canMutate() || mutationPending) {
      return;
    }
    setView((draft) => {
      draft.message = null;
    });
    const result = showConfirmDialog({
      title: t("mcpServers.removeConfirmTitle", { name }),
      message: t("mcpServers.removeConfirmMessage"),
      confirmLabel: t("common.remove"),
      danger: true,
    }).then(async (confirmed) => {
      if (!confirmed) {
        return;
      }
      await mutate({
        buildPatch: (servers) => buildRemoveMcpServerPatch(servers, name),
        note: `mcp settings: remove server ${name}`,
        successText: t("mcpServers.removedSuccess", { name }),
      });
    });
    void setCompletion(result);
    void result.catch(() => {});
  };
  const rows = createMemo(() =>
    summarizeMcpServers(resolveEditableSnapshotConfig(config.read().configSnapshot)),
  );
  const disabled = () => busy() || !canMutate();
  const closeForm = () =>
    setView((draft) => {
      draft.formOpen = false;
    });

  return (
    <openclaw-mcp-servers-card>
      <div class="mcp-server-list">
        <SettingsSection
          title={t("mcpPage.servers")}
          actions={
            <>
              <button
                type="button"
                class="btn btn--sm"
                title={mutationBlockedReason() ?? ""}
                disabled={disabled()}
                onClick={() => {
                  setCompletion(undefined);
                  setView((draft) => {
                    draft.message = null;
                    draft.formError = null;
                    draft.formOpen = true;
                  });
                }}
              >
                <Icon name="plus" />
                {t("mcpServers.add")}
              </button>
              <McpServersHelp />
            </>
          }
          notice={
            <>
              <Show when={!busy()}>
                <Loading on={completion()}>
                  <Errored
                    fallback={(error) => (
                      <div class="mcp-server-message" role="alert">
                        {formatUiError(error())}
                      </div>
                    )}
                  >
                    {completed()}
                  </Errored>
                </Loading>
              </Show>
              {/* The row itself shows the outcome; this only announces it. */}
              <span class="sr-only" role="status">
                {!busy() && view.message ? view.message.text : ""}
              </span>
            </>
          }
        >
          <Show when={rows()} fallback={<SettingsLoadingSkeleton rows={2} />}>
            {(servers) => (
              <Show
                when={servers().length > 0}
                fallback={
                  <SettingsEmpty
                    message={
                      <>
                        {t("mcpPage.noServers")}{" "}
                        <DocsLink url={props.docsUrl}>{t("mcpPage.setUpFirstServer")}</DocsLink>
                      </>
                    }
                  />
                }
              >
                <For each={servers()} keyed={(server) => server.name}>
                  {(server) => (
                    <McpServerRow
                      server={server()}
                      runtime={resolveReadMcpServerRuntime(
                        toolsRead(),
                        server().name,
                        savedServers(config.read().configSnapshot)[server().name],
                      )}
                      open={view.expanded === server().name}
                      disabled={disabled()}
                      saving={busy()}
                      blockedReason={mutationBlockedReason()}
                      canSignIn={canSignIn(server())}
                      editor={
                        view.expanded === server().name
                          ? props.renderEditor?.(server(), (name) =>
                              setView((draft) => {
                                draft.expanded = name;
                              }),
                            )
                          : undefined
                      }
                      onToggleOpen={() =>
                        setView((draft) => {
                          draft.expanded = draft.expanded === server().name ? null : server().name;
                        })
                      }
                      onToggleEnabled={(enabled) => void toggleServer(server().name, enabled)}
                      onSignIn={() => signIn(server())}
                      onRemove={() => removeServer(server().name)}
                    />
                  )}
                </For>
              </Show>
            )}
          </Show>
        </SettingsSection>
      </div>
      <Show when={view.formOpen}>
        <openclaw-modal-dialog
          prop:initialFocus={() => addNameInput ?? null}
          label={t("mcpServers.add")}
          onModal-cancel={(event) => {
            if (busy()) {
              event.preventDefault();
            } else {
              closeForm();
            }
          }}
        >
          <div class="exec-approval-card mcp-server-dialog">
            <div class="exec-approval-header">
              <div class="exec-approval-title">{t("mcpServers.add")}</div>
            </div>
            <McpServersForm
              onNameRef={(element) => {
                addNameInput = element;
              }}
              busy={busy()}
              disabled={!canMutate()}
              blockedReason={mutationBlockedReason()}
              autofocus
              error={view.formError}
              onSubmit={(form) => void addServer(form)}
              onCancel={closeForm}
            />
          </div>
        </openclaw-modal-dialog>
      </Show>
      <WizardLogin
        controller={login}
        options={{ doneMessage: t("mcpServers.authenticationSaved") }}
      />
    </openclaw-mcp-servers-card>
  );
}
