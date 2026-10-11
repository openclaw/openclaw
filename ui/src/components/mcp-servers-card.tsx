import { createMemo, createRenderEffect, createSignal, For, onCleanup, Show } from "solid-js";
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
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
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
import { WizardLoginController } from "./wizard-login-controller.ts";

registerMcpEnglish();

type McpServersCardProps = { pluginsHref: string; docsUrl: string };
type McpServerMessage = { kind: "error" | "success"; text: string };

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
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

function McpServersCardContent(props: McpServersCardProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = projectSource(context.runtimeConfig, {
    read: (source) => source.state,
    subscribe: (source, notify) => source.subscribe(notify),
    equality: "revision",
  });
  // Admission reads the same synchronous presentation state that the view projects.
  const state: { busy: boolean; message: McpServerMessage | null; formOpen: boolean } = {
    busy: false,
    message: null,
    formOpen: false,
  };
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const invalidate = () => setRevision((value) => value + 1);
  const view = () => {
    revision();
    return state;
  };
  let active = true;
  const login = new WizardLoginController(
    { requestUpdate: invalidate },
    {
      getClient: () => context.gateway.snapshot.client ?? null,
      getAgentId: () => null,
      onClose: () => login.reset(),
      requestFailedMessage: () => t("mcpServers.signInFailed"),
      sessionExpiredMessage: () => t("mcpServers.signInExpired"),
    },
  );
  void context.runtimeConfig.ensureLoaded().catch((error: unknown) => {
    state.message = { kind: "error", text: formatUiError(error) };
    invalidate();
  });
  const hello = createMemo(() => gateway.read().snapshot.hello);
  createRenderEffect(hello, () => {
    login.reset();
  });
  const stopSelection = context.agentSelection.subscribe(() => login.reset());
  onCleanup(() => {
    active = false;
    stopSelection();
    login.reset();
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
  const canMutate = () => {
    revision();
    return mutationBlockedReason() === null && login.runner.state.phase === "idle";
  };
  const signIn = (server: McpServerSummary) => {
    if (
      state.busy ||
      !canMutate() ||
      !server.enabled ||
      server.signIn !== "operator" ||
      !canCallGatewayMethod(context.gateway.snapshot, "mcp.authLogin", "operator.admin")
    ) {
      return;
    }
    state.message = null;
    invalidate();
    login.runner.prepareSignIn("oauth", server.name);
    void login.runner.startMcpLogin(server.name);
  };
  const mutate = async (options: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
    successText: string;
  }): Promise<boolean> => {
    if (!active || !canMutate() || state.busy) {
      return false;
    }
    state.busy = true;
    state.message = null;
    invalidate();
    const result = await patchMcpServers(context.runtimeConfig, options);
    state.busy = false;
    state.message = result.ok
      ? { kind: "success", text: options.successText }
      : { kind: "error", text: result.error };
    invalidate();
    return result.ok;
  };
  const addServer = async (form: McpServerForm) => {
    if (!MCP_SERVER_NAME_PATTERN.test(form.name)) {
      state.message = { kind: "error", text: t("mcpServers.nameInvalid") };
      invalidate();
      return;
    }
    const target = parseMcpTarget(form.target, form.transport);
    if (!target) {
      state.message = { kind: "error", text: t("mcpServers.targetInvalid") };
      invalidate();
      return;
    }
    if (
      await mutate({
        buildPatch: (servers) => buildAddMcpServerPatch(servers, form.name, target),
        note: `mcp settings: add server ${form.name}`,
        successText: t("mcpServers.addedSuccess", { name: form.name }),
      })
    ) {
      state.formOpen = false;
      invalidate();
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
  const rows = () =>
    summarizeMcpServers(resolveEditableSnapshotConfig(config.read().configSnapshot));
  const disabled = () => view().busy || !canMutate();

  return (
    <>
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
                state.formOpen = !state.formOpen;
                if (state.formOpen) {
                  state.message = null;
                }
                invalidate();
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
                state.formOpen = false;
                invalidate();
              }}
            />
          </Show>
          <Show when={view().message}>
            {(message) => (
              <div
                class={`mcp-server-message mcp-server-message--${message().kind}`}
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
      {login.renderSolid(revision, () => ({ doneMessage: t("mcpServers.authenticationSaved") }))}
    </>
  );
}

export const McpServersCard = defineSolidBridge<McpServersCardProps>(
  "openclaw-mcp-servers-card",
  (props) => <McpServersCardContent {...props} />,
  {
    properties: {
      pluginsHref: { default: "" },
      docsUrl: { default: "https://docs.openclaw.ai/tools/mcp" },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-servers-card": SolidBridgeElement<McpServersCardProps>;
  }
}
