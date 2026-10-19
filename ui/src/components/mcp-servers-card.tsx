import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { shellEscapeBackslash } from "../../../src/shared/shell-quote.js";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { registerMcpEnglish } from "../i18n/locales/en-mcp.ts";
import { resolveEditableSnapshotConfig } from "../lib/config/config-state-model.ts";
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
import { projectSource } from "../lib/reactive/projection.ts";
import type { McpServerForm } from "./mcp-server-form.ts";
import { McpServersForm } from "./mcp-servers-form.tsx";
import { Icon } from "./solid/icon.tsx";
import {
  DocsLink,
  LearnMoreLink,
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsSection,
  SettingsStatus,
} from "./solid/settings-ui.tsx";
import { createWizardLogin, WizardLogin } from "./wizard-login-controller.tsx";

registerMcpEnglish();

type McpServersCardProps = { pluginsHref: string; docsUrl: string };
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

export function McpServersCard(props: McpServersCardProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = projectSource(context.runtimeConfig, {
    read: (source) => source.state,
    subscribe: (source, notify) => source.subscribe(notify),
    equality: "revision",
  });
  const [view, setView] = createSignal<{
    busy: boolean;
    message: McpServerMessage | null;
    formOpen: boolean;
  }>({ busy: false, message: null, formOpen: false });
  // Admission must be synchronous even before Solid publishes the busy state.
  let mutationPending = false;
  let active = true;
  const login = createWizardLogin({
    getClient: () => context.gateway.snapshot.client ?? null,
    getAgentId: () => null,
    onClose: () => login.reset(),
    requestFailedMessage: () => t("mcpServers.signInFailed"),
    sessionExpiredMessage: () => t("mcpServers.signInExpired"),
  });
  void context.runtimeConfig.ensureLoaded().catch((error: unknown) => {
    setView((state) => ({ ...state, message: { kind: "error", text: formatUiError(error) } }));
  });
  onSettled(() => {
    let hello = context.gateway.snapshot.hello;
    // Retire sign-in with its transport, before the next interaction can reuse it.
    const stopGateway = context.gateway.subscribe((snapshot) => {
      if (snapshot.hello !== hello) {
        hello = snapshot.hello;
        login.reset();
      }
    });
    const stopSelection = context.agentSelection.subscribe(() => login.reset());
    return () => {
      active = false;
      stopGateway();
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
    setView((state) => ({ ...state, message: null }));
    login.runner.prepareSignIn("oauth", server.name);
    void login.runner.startMcpLogin(server.name);
  };
  const mutate = async (options: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
    successText: string;
  }): Promise<boolean> => {
    if (!active || !canMutate() || mutationPending) {
      return false;
    }
    mutationPending = true;
    setView((state) => ({ ...state, busy: true, message: null }));
    try {
      await patchMcpServers(context.runtimeConfig, options);
      setView((state) => ({ ...state, message: { kind: "success", text: options.successText } }));
      return true;
    } catch (error) {
      setView((state) => ({ ...state, message: { kind: "error", text: formatUiError(error) } }));
      return false;
    } finally {
      mutationPending = false;
      setView((state) => ({ ...state, busy: false }));
    }
  };
  const addServer = async (form: McpServerForm) => {
    if (!MCP_SERVER_NAME_PATTERN.test(form.name)) {
      setView((state) => ({
        ...state,
        message: { kind: "error", text: t("mcpServers.nameInvalid") },
      }));
      return;
    }
    const target = parseMcpTarget(form.target, form.transport);
    if (!target) {
      setView((state) => ({
        ...state,
        message: { kind: "error", text: t("mcpServers.targetInvalid") },
      }));
      return;
    }
    if (
      await mutate({
        buildPatch: (servers) => buildAddMcpServerPatch(servers, form.name, target),
        note: `mcp settings: add server ${form.name}`,
        successText: t("mcpServers.addedSuccess", { name: form.name }),
      })
    ) {
      setView((state) => ({ ...state, formOpen: false }));
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
  const removeServer = (name: string) =>
    mutate({
      buildPatch: (servers) => buildRemoveMcpServerPatch(servers, name),
      note: `mcp settings: remove server ${name}`,
      successText: t("mcpServers.removedSuccess", { name }),
    });
  const rows = createMemo(() =>
    summarizeMcpServers(resolveEditableSnapshotConfig(config.read().configSnapshot)),
  );
  const disabled = () => view().busy || !canMutate();

  return (
    <openclaw-mcp-servers-card>
      <div class="mcp-server-list">
        <SettingsSection
          title={t("mcpPage.configuredServers")}
          description={
            <>
              {t("mcpPage.runtimeHint")} <LearnMoreLink url={props.pluginsHref} />
            </>
          }
          actions={
            <button
              type="button"
              class="btn btn--sm"
              title={mutationBlockedReason() ?? ""}
              disabled={disabled()}
              onClick={() => {
                setView((state) => ({
                  ...state,
                  formOpen: !state.formOpen,
                  message: state.formOpen ? state.message : null,
                }));
              }}
            >
              <span aria-hidden="true">
                <Icon name="plus" />
              </span>
              {t("mcpServers.add")}
            </button>
          }
        >
          <Show when={view().formOpen}>
            <McpServersForm
              busy={view().busy}
              disabled={!canMutate()}
              blockedReason={mutationBlockedReason()}
              onSubmit={(form) => void addServer(form)}
              onCancel={() => {
                setView((state) => ({ ...state, formOpen: false }));
              }}
            />
          </Show>
          <Show when={view().message}>
            {(message) => (
              <div
                class={["mcp-server-message", `mcp-server-message--${message().kind}`]}
                role={message().kind === "error" ? "alert" : "status"}
              >
                {message().text}
              </div>
            )}
          </Show>
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
                  {(server) => {
                    const command = () =>
                      `openclaw mcp ${server().auth === "oauth" ? "login" : "probe"} ${quoteShellArg(server().name)}`;
                    return (
                      <div class="settings-row mcp-server-row" data-mcp-name={server().name}>
                        <div class="settings-row__text">
                          <span class="settings-row__title">{server().name}</span>
                          <span class="settings-row__desc mcp-server-row__launch">
                            {server().target || t("mcpServers.missingTransport")}
                          </span>
                          <span class="settings-row__desc">
                            {[
                              server().transport,
                              server().auth,
                              server().toolFilter ? t("mcpPage.toolFilter") : null,
                              server().parallel ? t("mcpPage.parallel") : null,
                              tlsLabel(server().tls),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        <div class="settings-row__control">
                          <SettingsStatus
                            kind={server().enabled ? "ok" : "muted"}
                            label={server().enabled ? t("common.enabled") : t("common.disabled")}
                          />
                          <Show
                            when={server().signIn === "profile"}
                            fallback={
                              <Show
                                when={server().signIn === "requester"}
                                fallback={<code>{command()}</code>}
                              >
                                <span class="settings-row__desc">
                                  {t("mcpServers.requesterSignIn")}
                                </span>
                              </Show>
                            }
                          >
                            <span class="settings-row__desc">{t("mcpServers.profileSignIn")}</span>
                          </Show>
                          <Show
                            when={
                              server().enabled &&
                              server().signIn === "operator" &&
                              canCallGatewayMethod(
                                gateway.read().snapshot,
                                "mcp.authLogin",
                                "operator.admin",
                              )
                            }
                          >
                            <button
                              type="button"
                              class="btn btn--sm"
                              disabled={disabled()}
                              onClick={() => signIn(server())}
                            >
                              {t("mcpServers.signIn")}
                            </button>
                          </Show>
                          <button
                            type="button"
                            class="btn btn--sm"
                            title={mutationBlockedReason() ?? ""}
                            disabled={disabled()}
                            onClick={() => void toggleServer(server().name, !server().enabled)}
                          >
                            {view().busy
                              ? t("mcpServers.working")
                              : server().enabled
                                ? t("mcpServers.disable")
                                : t("mcpServers.enable")}
                          </button>
                          <button
                            type="button"
                            class="btn btn--sm btn--icon mcp-server-remove"
                            aria-label={t("mcpServers.removeNamed", { name: server().name })}
                            title={
                              mutationBlockedReason() ??
                              t("mcpServers.removeNamed", { name: server().name })
                            }
                            disabled={disabled()}
                            onClick={() => void removeServer(server().name)}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
            )}
          </Show>
        </SettingsSection>
      </div>
      <WizardLogin
        controller={login}
        options={{ doneMessage: t("mcpServers.authenticationSaved") }}
      />
    </openclaw-mcp-servers-card>
  );
}
