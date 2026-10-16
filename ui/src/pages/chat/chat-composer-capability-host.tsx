import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot, GatewaySessionRow, ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import type { McpServerForm } from "../../components/mcp-server-form.ts";
import "../../components/modal-dialog.ts";
import { registerMcpEnglish } from "../../i18n/locales/en-mcp.ts";
import { buildToolsEffectiveRequestKey } from "../../lib/agents/tools-effective.ts";
import { currentDisplayRuntimeConfig } from "../../lib/config/config-state-model.ts";
import {
  buildAddMcpServerPatch,
  MCP_SERVER_NAME_PATTERN,
  parseMcpTarget,
  patchMcpServers,
  summarizeMcpServers,
} from "../../lib/config/mcp-servers.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "../../lib/sessions/index.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { nextBooleanToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import { LibraryPinRead } from "../skills/library-detail.tsx";
import { refreshCurrentChatSessionList } from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { ComposerAddServerDialog } from "./components/chat-composer-add-server-dialog.tsx";
import type { ChatComposerCapabilityMenuProps } from "./components/chat-composer-plus-menu.types.ts";
import {
  ComposerSkillCatalog,
  composerWebSearchBaseEnabled,
} from "./composer-capability-catalog.ts";
import { ComposerLibrarySession } from "./composer-library-session.ts";

registerMcpEnglish();

type ComposerMcpServerScope = "session" | "everywhere";

function activeConfigFingerprint(
  snapshot: ConfigSnapshot | null,
  bootstrap: Record<string, unknown> | null,
): string {
  const revision =
    snapshot?.appliedConfigHash ?? snapshot?.configRevisionHash ?? snapshot?.hash ?? null;
  // Without a revision hash, connector edits still invalidate the effective tools.
  return (
    revision ||
    JSON.stringify(asRecord(asRecord(snapshot?.runtimeConfig ?? bootstrap)?.mcp)?.servers ?? null)
  );
}

export class ChatComposerCapabilityHost {
  private readonly skillCatalog: ComposerSkillCatalog;
  private readonly library: ComposerLibrarySession;
  private readonly patchTokens = new Map<string, symbol>();
  private effectiveTools: { key: string; result: ToolsEffectiveResult } | null = null;
  private effectiveToolsErrorKey: string | null = null;
  private effectiveToolsRequest: { key: string } | null = null;
  private client: GatewayBrowserClient | null = null;
  private connectionEpoch: number | undefined;
  private addDialogOpen = false;
  private addScope: ComposerMcpServerScope = "session";
  private addBusy = false;
  private addError: string | null = null;

  constructor(private readonly notify: () => void) {
    this.skillCatalog = new ComposerSkillCatalog(notify);
    this.library = new ComposerLibrarySession(notify);
  }

  private effectiveToolsKeys(
    context: ApplicationContext,
    state: ChatPageHost,
    agentId: string,
  ): string {
    const requestKey = buildToolsEffectiveRequestKey(
      {
        chatModelCatalog: state.chatModelCatalog,
        sessions: context.sessions,
        sessionsResult: state.sessionsResult,
      },
      { agentId, sessionKey: state.sessionKey },
    );
    const configFingerprint = activeConfigFingerprint(
      context.runtimeConfig.state.configSnapshot ?? null,
      currentDisplayRuntimeConfig(context.runtimeConfig.state),
    );
    return `${requestKey}\0config=${configFingerprint}`;
  }

  private loadEffectiveTools(
    context: ApplicationContext,
    state: ChatPageHost,
    agentId: string,
    retryError = false,
  ): void {
    const client = state.client;
    const sessionKey = state.sessionKey;
    const cacheKey = this.effectiveToolsKeys(context, state, agentId);
    if (
      !state.connected ||
      !client ||
      !agentId.trim() ||
      !sessionKey.trim() ||
      this.effectiveTools?.key === cacheKey ||
      this.effectiveToolsRequest?.key === cacheKey ||
      (!retryError && this.effectiveToolsErrorKey === cacheKey)
    ) {
      return;
    }
    const request = { key: cacheKey };
    const connectionEpoch = state.connectionEpoch;
    this.effectiveToolsRequest = request;
    const isCurrent = () =>
      this.effectiveToolsRequest === request &&
      this.client === client &&
      state.client === client &&
      state.connected &&
      this.connectionEpoch === connectionEpoch &&
      state.connectionEpoch === connectionEpoch &&
      state.sessionKey === sessionKey &&
      this.effectiveToolsKeys(context, state, agentId) === cacheKey;
    this.effectiveToolsErrorKey = null;
    this.notify();
    void client
      .request<ToolsEffectiveResult>("tools.effective", {
        agentId: agentId.trim(),
        sessionKey: sessionKey.trim(),
      })
      .then((result) => {
        if (isCurrent()) {
          this.effectiveTools = { key: cacheKey, result };
        }
      })
      .catch(() => {
        if (isCurrent()) {
          this.effectiveToolsErrorKey = cacheKey;
        }
      })
      .finally(() => {
        if (this.effectiveToolsRequest === request) {
          this.effectiveToolsRequest = null;
          if (this.client === client && this.connectionEpoch === connectionEpoch) {
            this.notify();
          }
        }
      });
  }

  private async patch(
    context: ApplicationContext,
    state: ChatPageHost,
    next: SessionToolOverrides | null,
  ): Promise<string | undefined> {
    if (!state.connected || !state.client) {
      return t("chat.composer.menu.offlineBlocked");
    }
    const access = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: state.sessionKey, toolOverrides: next },
    });
    if (!access.allowed) {
      return access.reason;
    }
    const sessionKey = state.sessionKey;
    if (this.patchTokens.has(sessionKey)) {
      return t("chat.composer.menu.savingBlocked");
    }
    const client = state.client;
    const patchToken = Symbol(sessionKey);
    this.patchTokens.set(sessionKey, patchToken);
    const isCurrentPatch = () =>
      this.client === client &&
      state.client === client &&
      state.sessionKey === sessionKey &&
      this.patchTokens.get(sessionKey) === patchToken;
    state.lastError = null;
    state.chatError = null;
    this.notify();
    try {
      const result = await patchChatSessionSettings(
        state,
        sessionKey,
        { toolOverrides: next },
        scopedAgentParamsForSession(state, sessionKey),
      );
      if (!result) {
        throw new Error(t("chat.composer.menu.offlineBlocked"));
      }
      return undefined;
    } catch (error) {
      const message = formatUiError(error);
      if (isCurrentPatch()) {
        try {
          await refreshCurrentChatSessionList(state);
        } catch {
          // The unchanged session row remains authoritative if refresh also fails.
        }
        if (isCurrentPatch()) {
          state.lastError = message;
          state.chatError = message;
        }
      }
      return message;
    } finally {
      if (this.patchTokens.get(sessionKey) === patchToken) {
        this.patchTokens.delete(sessionKey);
        if (this.client === client) {
          this.notify();
        }
      }
    }
  }

  private closeAddDialog(): void {
    if (this.addBusy) {
      return;
    }
    this.addDialogOpen = false;
    this.addError = null;
    this.notify();
  }

  private addServerBlockedReason(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
    scope: ComposerMcpServerScope,
  ): string | null {
    const access = readGatewayOperatorAccess(context.gateway.snapshot);
    if (!state.connected || !state.client) {
      return t("chat.composer.menu.offlineBlocked");
    }
    if (!access.canAdmin) {
      return t("chat.composer.menu.adminBlocked");
    }
    if (scope === "everywhere") {
      return null;
    }
    if (!session) {
      return t("common.loading");
    }
    return this.patchTokens.has(state.sessionKey) ? t("chat.composer.menu.savingBlocked") : null;
  }

  private async loadCurrentSessionOverrides(
    state: ChatPageHost,
    sessionKey: string,
    agentId: string | undefined,
  ) {
    const identityMatches = () =>
      state.sessionKey === sessionKey &&
      scopedAgentListParamsForSession(state, sessionKey).agentId === agentId;
    if (!identityMatches()) {
      throw new Error(t("mcpServers.sessionChanged"));
    }
    await refreshCurrentChatSessionList(state);
    if (!identityMatches()) {
      throw new Error(t("mcpServers.sessionChanged"));
    }
    const sessions = state.sessions.state;
    if (sessions.error) {
      throw new Error(sessions.error);
    }
    const row = sessions.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, sessionKey),
    );
    if (!row || (sessions.agentId ?? undefined) !== agentId) {
      throw new Error(t("mcpServers.sessionUnavailable"));
    }
    return row.toolOverrides;
  }

  private async submitAddServer(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
    form: McpServerForm,
  ): Promise<void> {
    if (this.addBusy) {
      return;
    }
    const blockedReason = this.addServerBlockedReason(context, state, session, this.addScope);
    if (blockedReason) {
      this.addError = blockedReason;
      this.notify();
      return;
    }
    const name = form.name.trim();
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      this.addError = t("mcpServers.nameInvalid");
      this.notify();
      return;
    }
    const config = parseMcpTarget(form.target, form.transport);
    if (!config) {
      this.addError = t("mcpServers.targetInvalid");
      this.notify();
      return;
    }
    this.addBusy = true;
    this.addError = null;
    this.notify();
    const sessionKey = state.sessionKey;
    const agentId = scopedAgentListParamsForSession(state, sessionKey).agentId;
    const scope = this.addScope;
    const globalConfig = scope === "session" ? { ...config, enabled: false } : config;
    let stage: "config" | "session" = "config";
    let failure: string | undefined;
    try {
      await patchMcpServers(context.runtimeConfig, {
        buildPatch: (servers) => buildAddMcpServerPatch(servers, name, globalConfig),
        note: `composer connectors: add MCP server ${name}`,
      });
      if (scope === "session") {
        stage = "session";
        const overrides = await this.loadCurrentSessionOverrides(state, sessionKey, agentId);
        const next = nextBooleanToolOverrides(overrides, "mcpServers", name, true, false);
        failure = await this.patch(context, state, next);
      }
    } catch (error) {
      failure = formatUiError(error);
    } finally {
      this.addBusy = false;
    }
    if (failure !== undefined) {
      const error = formatUiExternalText(failure);
      this.addError = stage === "session" ? t("mcpServers.sessionEnableFailed", { error }) : error;
      this.notify();
      return;
    }
    this.addDialogOpen = false;
    this.notify();
  }

  dialogView(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
  ) {
    return {
      open: this.addDialogOpen,
      busy: this.addBusy,
      scope: this.addScope,
      error: this.addError,
      scopeBlockedReason: this.addServerBlockedReason(context, state, session, "everywhere"),
      submitBlockedReason: this.addServerBlockedReason(context, state, session, this.addScope),
      onCancel: (event?: Event) => {
        if (this.addBusy) {
          event?.preventDefault();
          return;
        }
        this.closeAddDialog();
      },
      onScopeChange: (scope: ComposerMcpServerScope) => {
        this.addScope = scope;
        this.addError = null;
        this.notify();
      },
      onSubmit: (form: McpServerForm) => {
        void this.submitAddServer(context, state, session, form);
      },
      library: this.library.read
        ? {
            read: this.library.read,
            file: this.library.selectedFile,
            onFile: (file: string) => {
              this.library.selectedFile = file;
              this.notify();
            },
            onClose: () => {
              this.library.closeRead();
              this.notify();
            },
          }
        : null,
    };
  }

  props(
    context: ApplicationContext,
    state: ChatPageHost,
    session: GatewaySessionRow | undefined,
    agentId: string,
    toolAccessOpen = false,
    skillsOpen = false,
  ): ChatComposerCapabilityMenuProps {
    if (this.client !== state.client || this.connectionEpoch !== state.connectionEpoch) {
      this.client = state.client;
      this.connectionEpoch = state.connectionEpoch;
      this.skillCatalog.synchronize(state.client, state.connectionEpoch);
      this.patchTokens.clear();
      this.effectiveTools = null;
      this.effectiveToolsErrorKey = null;
      this.effectiveToolsRequest = null;
    }
    const client = state.client;
    const connectionEpoch = state.connectionEpoch;
    const sessionKey = state.sessionKey;
    const current = () =>
      state.connected &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch &&
      state.sessionKey === sessionKey;
    this.library.synchronize(
      client && state.connected
        ? { client, connectionEpoch, sessionKey, agentId, isCurrent: current }
        : null,
    );
    if (skillsOpen && !this.library.result && !this.library.loading && !this.library.error) {
      void this.library.load();
    }
    const canWriteLibrary = canCallGatewayMethod(
      context.gateway.snapshot,
      "skills.library.activate",
      "operator.write",
      { requireAdvertisement: false },
    );
    // Sparse session overrides resolve against active runtime defaults, so display and key
    // removal decisions must use the same runtime snapshot that executes the session.
    const runtimeConfig = currentDisplayRuntimeConfig(context.runtimeConfig.state);
    const access = readGatewayOperatorAccess(context.gateway.snapshot);
    const gatewayAvailable = state.connected && Boolean(state.client);
    const effectiveToolsAvailable =
      isGatewayMethodAdvertised(context.gateway.snapshot, "tools.effective") === true;
    // Start before projecting loading state; a notification during render
    // cannot schedule the second render that the old menu callback relied on.
    if (effectiveToolsAvailable && toolAccessOpen) {
      this.loadEffectiveTools(context, state, agentId);
    }
    const effectiveToolsKey = effectiveToolsAvailable
      ? this.effectiveToolsKeys(context, state, agentId)
      : null;
    const toolsEffectiveResult =
      effectiveToolsKey !== null && this.effectiveTools?.key === effectiveToolsKey
        ? this.effectiveTools.result
        : null;
    const toolsEffectiveLoading =
      effectiveToolsKey !== null && this.effectiveToolsRequest?.key === effectiveToolsKey;
    const toolsEffectiveError =
      effectiveToolsKey !== null && this.effectiveToolsErrorKey === effectiveToolsKey;
    const capabilitiesReady = gatewayAvailable && session !== undefined && runtimeConfig !== null;
    const toolPatchAccess = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: state.sessionKey, toolOverrides: null },
    });
    const mutationBlockedReason = !gatewayAvailable
      ? t("chat.composer.menu.offlineBlocked")
      : !capabilitiesReady
        ? t("common.loading")
        : !toolPatchAccess.allowed
          ? toolPatchAccess.reason
          : this.patchTokens.has(state.sessionKey)
            ? t("chat.composer.menu.savingBlocked")
            : null;
    const toolAccessMutationBlockedReason =
      mutationBlockedReason ??
      (toolsEffectiveResult
        ? null
        : toolsEffectiveError
          ? t("chat.composer.menu.toolAccess.loadFailed")
          : t("common.loading"));
    const adminBlockedReason = !gatewayAvailable
      ? t("chat.composer.menu.offlineBlocked")
      : !access.canAdmin
        ? t("chat.composer.menu.adminBlocked")
        : null;
    return {
      basePath: state.basePath,
      skills: this.skillCatalog.rows(agentId, session?.toolOverrides),
      skillsLoading: this.skillCatalog.isLoading(agentId),
      skillsError: this.skillCatalog.hasError(agentId),
      mcpServers: summarizeMcpServers(runtimeConfig) ?? [],
      toolsEffectiveResult,
      toolsEffectiveLoading,
      toolsEffectiveError,
      toolAccessMutationBlockedReason,
      webSearchBaseEnabled: composerWebSearchBaseEnabled(runtimeConfig),
      mutationBlockedReason,
      canAdmin: access.canAdmin && gatewayAvailable,
      adminBlockedReason,
      library: {
        result: this.library.result,
        loading: this.library.loading,
        busy: this.library.busy,
        error: this.library.error,
        notice: this.library.notice,
        canWrite: canWriteLibrary,
        onReload: () => {
          if (current()) {
            void this.library.load(true);
          }
        },
        onRead: (skillId, revision) => {
          if (current()) {
            void this.library.openRead(skillId, revision);
          }
        },
        onActivate: (action, skillId, revision) => {
          if (current() && canWriteLibrary) {
            void this.library.activate(action, skillId, revision);
          }
        },
      },
      onLoadSkills: () => {
        if (!current()) {
          return;
        }
        const config = context.runtimeConfig.state;
        if (!config.configSnapshot && !config.configLoading) {
          void context.runtimeConfig.ensureLoaded().catch(() => undefined);
        }
        const skillClient = state.client;
        const skillEpoch = state.connectionEpoch;
        this.skillCatalog.load(
          skillClient,
          skillEpoch,
          agentId,
          () =>
            state.connected && state.client === skillClient && state.connectionEpoch === skillEpoch,
        );
        void this.library.load(true);
      },
      onPatchToolOverrides: (next) => void this.patch(context, state, next),
      onNavigate: (routeId, options) => context.navigate(routeId, options),
      onAddServer: () => {
        if (!access.canAdmin || !gatewayAvailable) {
          return;
        }
        this.addDialogOpen = true;
        this.addScope = "session";
        this.addError = null;
        this.notify();
      },
      ...(effectiveToolsAvailable
        ? {
            onOpenToolAccess: () => this.loadEffectiveTools(context, state, agentId, true),
          }
        : {}),
    };
  }
}

export type ChatComposerCapabilityDialogsProps = {
  read: () => ReturnType<ChatComposerCapabilityHost["dialogView"]>;
  revision: object;
};

export function ChatComposerCapabilityDialogs(props: ChatComposerCapabilityDialogsProps) {
  const view = createMemo(() => {
    void props.revision;
    return props.read();
  });
  return (
    <>
      <ComposerAddServerDialog {...view()} />
      <Show when={view().library}>{(library) => <LibraryPinRead {...library()} />}</Show>
    </>
  );
}
