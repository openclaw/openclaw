import { createSignal, onCleanup } from "solid-js";
import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.ts";
import type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerGitHubConnectionsEnglish } from "../../i18n/locales/en-github-connections.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { createGitHubDeviceAuthorization } from "./github-device-authorization.ts";
import {
  githubConnectionOwnerKey,
  readGitHubIdentityDraft,
  type GitHubConnectionTarget,
  type GitHubIdentityDraft,
  type GitHubIdentityDependencies,
  type GitHubIdentityScope,
  type RequestOwner,
  type SharedRequestOwner,
} from "./github-identity-shared.ts";

export type GitHubIdentity = ReturnType<typeof createGitHubIdentity>;

export function createGitHubIdentity(deps: GitHubIdentityDependencies = {}) {
  let status: ToolsGitHubStatusResult | null = null;
  let personal: PersonalGitHubStatus | null = null;
  let system: GitHubIdentityFacts | null = null;
  let loading = false;
  let busy = false;
  let error: string | null = null;
  let statusReadable = false;
  let configurable = false;
  let authorizable = false;
  const [tokenRevealed, setTokenRevealed] = createSignal(false);
  const [patVisible, setPatVisible] = createSignal(false);

  let target: GitHubConnectionTarget | null = null;
  let client: GatewayBrowserClient | null = null;
  let connected = false;
  let clientRevision = -1;
  let requestRevision = 0;
  let displayedIdentityFingerprint: string | null = null;
  let verificationRequested = false;
  let verificationQueued = false;
  let confirmationPending = false;
  let mutationOwner: RequestOwner | null = null;
  let mutationIdentityChanged = false;
  let selectedDraft = readGitHubIdentityDraft(undefined);
  let draftDirty = false;
  let configFingerprint = "";

  let publish = () => {};

  const deviceAuthorization = createGitHubDeviceAuthorization({
    ...deps,
    publish: () => publish(),
    isCurrent: (owner) => authorizable && isCurrent(owner),
    begin: (owner) => beginMutation(owner),
    finish: (owner, succeeded) => finishMutation(owner, succeeded),
    applySuccess: (owner, result, refreshError) => {
      if (owner.target.kind === "personal" && "personal" in result) {
        personal = result.personal;
      } else if (owner.target.kind === "shared" && "githubStatus" in result) {
        applyMutationStatus(
          { ...owner, target: owner.target },
          result.githubStatus,
          { ...selectedDraft, token: "" },
          refreshError,
        );
      } else {
        throw new Error("Gateway returned GitHub authorization for a different target.");
      }
    },
  });
  const readScope = (): GitHubIdentityScope =>
    target?.kind === "personal" ? "personal" : (target?.scope ?? "system");
  const connectionReady = () => connected && client !== null;
  const readDraft = () =>
    readScope() === "personal" ? readGitHubIdentityDraft(undefined) : selectedDraft;

  function queueVerification() {
    if (
      verificationQueued ||
      confirmationPending ||
      !statusReadable ||
      !connectionReady() ||
      !target ||
      deviceAuthorization.active()
    ) {
      return;
    }
    verificationQueued = true;
    queueMicrotask(() => {
      verificationQueued = false;
      void verify();
    });
  }

  function sync(params: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    permissionsReady: boolean;
    target: GitHubConnectionTarget | null;
    statusReadable: boolean;
    configurable: boolean;
    authorizable: boolean;
    clientRevision: number;
  }) {
    const clientChanged = client !== params.client;
    const becameConnected = !connected && params.connected;
    const transportChanged =
      clientChanged || connected !== params.connected || clientRevision !== params.clientRevision;
    const ownerChanged =
      githubConnectionOwnerKey(target) !== githubConnectionOwnerKey(params.target);
    const nextScope =
      params.target?.kind === "personal" ? "personal" : (params.target?.scope ?? "system");
    const scopeChanged = readScope() !== nextScope;
    const nextConfigurable = params.target?.kind === "shared" && params.configurable;
    const capabilityChanged =
      params.permissionsReady &&
      (statusReadable !== params.statusReadable ||
        configurable !== nextConfigurable ||
        authorizable !== params.authorizable);
    const contextChanged = transportChanged || ownerChanged || scopeChanged || capabilityChanged;
    const accessLost =
      capabilityChanged &&
      ((statusReadable && !params.statusReadable) ||
        (configurable && !nextConfigurable) ||
        (authorizable && !params.authorizable));
    const presentationChanged = clientChanged || ownerChanged || scopeChanged || accessLost;
    if (presentationChanged) {
      verificationRequested = false;
    }
    if (contextChanged) {
      deviceAuthorization.retire(true);
      requestRevision += 1;
      mutationOwner = null;
      mutationIdentityChanged = false;
    }
    client = params.client;
    connected = params.connected;
    clientRevision = params.clientRevision;
    // Hello permissions are authoritative even while the profile identity is unresolved.
    if (params.permissionsReady) {
      statusReadable = params.statusReadable;
      configurable = nextConfigurable;
      authorizable = params.authorizable;
    }
    // An unavailable config is not evidence that the selected identity was removed.
    const nextTarget =
      params.target?.kind === "shared" &&
      params.target.config === null &&
      !presentationChanged &&
      target?.kind === "shared"
        ? { ...params.target, config: target.config }
        : params.target;
    target = nextTarget ? { ...nextTarget } : null;
    const resolved =
      nextTarget?.kind === "shared"
        ? resolveAgentConfig(nextTarget.config, nextTarget.agentId)
        : null;
    const values = { system: resolved?.globalTools?.github, agent: resolved?.entry?.tools?.github };
    const fingerprint = JSON.stringify(
      nextScope === "personal"
        ? null
        : {
            effective: values.agent ?? values.system,
            selectedScope: nextScope,
            selected: values[nextScope],
          },
    );
    const identityChanged =
      displayedIdentityFingerprint !== null && displayedIdentityFingerprint !== fingerprint;
    displayedIdentityFingerprint = fingerprint;
    const activeMutation = mutationOwner;
    const mutationOwnsIdentityChange =
      identityChanged && activeMutation !== null && busy && isCurrent(activeMutation);
    if (mutationOwnsIdentityChange) {
      mutationIdentityChanged = true;
    } else if (identityChanged) {
      requestRevision += 1;
      deviceAuthorization.retire(true);
    }
    if (contextChanged || (identityChanged && !mutationOwnsIdentityChange)) {
      loading = false;
      busy = false;
      setTokenRevealed(false);
      confirmationPending = false;
    }
    if (presentationChanged || (identityChanged && !mutationOwnsIdentityChange)) {
      status = null;
      personal = null;
      system = null;
      error = null;
      setPatVisible(false);
    }
    const selected = nextScope === "personal" ? undefined : values[nextScope];
    const selectedFingerprint = JSON.stringify(selected ?? null);
    const resetDraft = presentationChanged;
    if (resetDraft || (!draftDirty && configFingerprint !== selectedFingerprint)) {
      selectedDraft = readGitHubIdentityDraft(selected);
      draftDirty = false;
      configFingerprint = selectedFingerprint;
    }
    publish();
    if (clientChanged || ownerChanged) {
      return;
    }
    if (
      (becameConnected && verificationRequested) ||
      (identityChanged && !mutationOwnsIdentityChange)
    ) {
      queueVerification();
    }
  }

  function showPatFallback() {
    if (configurable && readScope() !== "personal" && !deviceAuthorization.active()) {
      setPatVisible(true);
    }
  }
  function hidePatFallback() {
    if (busy) {
      return;
    }
    setPatVisible(false);
    setTokenRevealed(false);
  }
  function toggleTokenVisibility() {
    if (!configurable || readScope() === "personal") {
      return;
    }
    setTokenRevealed((value) => !value);
  }
  function setDraft(field: keyof GitHubIdentityDraft, value: string) {
    if (readScope() === "personal") {
      return;
    }
    selectedDraft = { ...selectedDraft, [field]: value };
    draftDirty = true;
    publish();
  }

  function release() {
    deviceAuthorization.retire(true);
    requestRevision += 1;
    client = null;
    target = null;
    connected = false;
    mutationOwner = null;
    selectedDraft = readGitHubIdentityDraft(undefined);
  }
  function captureRequest(): RequestOwner | null {
    if (!client || !connected || !target) {
      return null;
    }
    return {
      client,
      target:
        target.kind === "personal"
          ? { ...target }
          : { kind: "shared", scope: target.scope, agentId: target.agentId },
      clientRevision,
      requestRevision: ++requestRevision,
    };
  }
  function isCurrent(owner: RequestOwner): boolean {
    return (
      client === owner.client &&
      connected &&
      clientRevision === owner.clientRevision &&
      requestRevision === owner.requestRevision
    );
  }

  async function startAuthorization() {
    if (!authorizable || deviceAuthorization.active() || busy || confirmationPending) {
      return;
    }
    const owner = captureRequest();
    if (!owner) {
      return;
    }
    loading = false;
    error = null;
    setPatVisible(false);
    await deviceAuthorization.start(owner);
  }

  function beginMutation(owner: RequestOwner) {
    mutationOwner = owner;
    mutationIdentityChanged = false;
    loading = false;
    busy = true;
    error = null;
    publish();
  }
  function finishMutation(owner: RequestOwner, succeeded: boolean) {
    if (mutationOwner !== owner) {
      return;
    }
    const verifyAfterSettle = mutationIdentityChanged && !succeeded;
    mutationOwner = null;
    mutationIdentityChanged = false;
    if (!isCurrent(owner)) {
      return;
    }
    busy = false;
    publish();
    if (verifyAfterSettle) {
      queueVerification();
    }
  }

  async function runMutation(owner: RequestOwner, run: () => Promise<boolean>): Promise<boolean> {
    beginMutation(owner);
    let succeeded = false;
    try {
      succeeded = await run();
    } catch (cause) {
      if (isCurrent(owner)) {
        error = formatUiError(cause);
      }
    } finally {
      finishMutation(owner, succeeded);
    }
    return succeeded;
  }

  function acceptSharedStatus(owner: SharedRequestOwner, nextStatus: ToolsGitHubStatusResult) {
    if (
      nextStatus.agentId !== owner.target.agentId ||
      nextStatus.selectedScope !== owner.target.scope ||
      nextStatus.selected.scope !== owner.target.scope
    ) {
      throw new Error("Gateway returned GitHub identity status for a different target.");
    }
    status = nextStatus;
    if (owner.target.scope === "system") {
      system = nextStatus.selected.identity;
    }
  }
  function applyMutationStatus(
    owner: SharedRequestOwner,
    nextStatus: ToolsGitHubStatusResult,
    nextDraft: GitHubIdentityDraft,
    refreshError: string | null,
  ) {
    if (!isCurrent(owner)) {
      return;
    }
    acceptSharedStatus(owner, nextStatus);
    selectedDraft = nextDraft;
    draftDirty = false;
    setTokenRevealed(false);
    setPatVisible(false);
    error = refreshError
      ? `GitHub identity was updated, but its configuration refresh failed: ${refreshError}`
      : null;
  }

  async function verify() {
    if (!statusReadable || loading || busy || confirmationPending || deviceAuthorization.active()) {
      return;
    }
    const owner = captureRequest();
    if (!owner) {
      return;
    }
    verificationRequested = true;
    loading = true;
    error = null;
    publish();
    try {
      if (owner.target.kind === "personal") {
        const result = await owner.client.request<UsersGitHubStatusResult>(
          "users.github.status",
          {},
        );
        // Status may restore a pending user code only while its exact profile and socket still own this view.
        if (!isCurrent(owner)) {
          return;
        }
        personal = result.personal;
        system = result.system;
        if (result.personal.pending && authorizable) {
          deviceAuthorization.restore(owner, result.personal.pending);
        }
      } else {
        const result = await owner.client.request<ToolsGitHubStatusResult>("tools.github.status", {
          agentId: owner.target.agentId,
          selectedScope: owner.target.scope,
        });
        if (isCurrent(owner)) {
          acceptSharedStatus({ ...owner, target: owner.target }, result);
        }
      }
    } catch (cause) {
      if (isCurrent(owner)) {
        error = formatUiError(cause);
      }
    } finally {
      if (isCurrent(owner)) {
        loading = false;
        publish();
      }
    }
  }

  async function disconnect() {
    if (target?.kind !== "personal" || !authorizable || busy || deviceAuthorization.active()) {
      return;
    }
    const owner = captureRequest();
    if (!owner) {
      return;
    }
    const succeeded = await runMutation(owner, async () => {
      await owner.client.request("users.github.disconnect", {});
      if (!isCurrent(owner)) {
        return false;
      }
      personal = null;
      return true;
    });
    if (succeeded && isCurrent(owner)) {
      await verify();
    }
  }

  async function configure() {
    if (
      target?.kind !== "shared" ||
      !configurable ||
      busy ||
      deviceAuthorization.active() ||
      confirmationPending
    ) {
      return;
    }
    const draft = { ...readDraft() };
    if (!draft.token.trim()) {
      error = t("agentTools.githubPasteToken");
      publish();
      return;
    }
    const captured = captureRequest();
    const runExternalMutation = deps.runExternalMutation;
    if (!captured || captured.target.kind !== "shared" || !runExternalMutation) {
      return;
    }
    const owner = { ...captured, target: captured.target };
    const name = draft.name.trim();
    const email = draft.email.trim();
    await runMutation(owner, async () => {
      const secretName = `github-setup-${generateUUID().replaceAll("-", "").toLowerCase()}`;
      let stored = false;
      try {
        await owner.client.request("secrets.store.set", {
          name: secretName,
          value: draft.token,
          kind: "secret",
          allowedHosts: [],
        });
        stored = true;
        if (!isCurrent(owner)) {
          return false;
        }
        const result = await runConfigureMutation(owner, runExternalMutation, {
          scope: owner.target.scope,
          agentId: owner.target.agentId,
          mode: "managed",
          secretName,
          ...(name || email
            ? { gitAuthor: { ...(name ? { name } : {}), ...(email ? { email } : {}) } }
            : {}),
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        stored = false;
        applyMutationStatus(
          owner,
          result.value,
          { ...draft, token: "" },
          result.refresh.ok ? null : result.refresh.error,
        );
        return true;
      } finally {
        if (stored) {
          await owner.client
            .request("secrets.store.delete", { name: secretName })
            .catch(() => undefined);
        }
      }
    });
  }

  async function inherit() {
    if (
      target?.kind !== "shared" ||
      !configurable ||
      busy ||
      deviceAuthorization.active() ||
      confirmationPending
    ) {
      return;
    }
    const captured = captureRequest();
    const runExternalMutation = deps.runExternalMutation;
    if (!captured || captured.target.kind !== "shared" || !runExternalMutation) {
      return;
    }
    const owner = { ...captured, target: captured.target };
    const selectedScope = owner.target.scope;
    confirmationPending = true;
    let confirmed = false;
    try {
      confirmed = await showConfirmDialog({
        title:
          selectedScope === "agent"
            ? t("agentTools.githubUseSystemConfirmTitle")
            : t("agentTools.githubUseNativeConfirmTitle"),
        message:
          selectedScope === "agent"
            ? t("agentTools.githubUseSystemConfirmMessage")
            : t("agentTools.githubUseNativeConfirmMessage"),
        confirmLabel:
          selectedScope === "agent"
            ? t("agentTools.githubUseSystemNewRuns")
            : t("agentTools.githubUseNativeNewRuns"),
      });
    } finally {
      if (isCurrent(owner)) {
        confirmationPending = false;
      }
    }
    if (!confirmed || !isCurrent(owner) || !configurable || busy || deviceAuthorization.active()) {
      return;
    }
    await runMutation(owner, async () => {
      const result = await runConfigureMutation(owner, runExternalMutation, {
        scope: selectedScope,
        agentId: owner.target.agentId,
        mode: "inherit",
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (isCurrent(owner)) {
        applyMutationStatus(
          owner,
          result.value,
          { token: "", name: "", email: "" },
          result.refresh.ok ? null : result.refresh.error,
        );
        return true;
      }
      return false;
    });
  }
  function runConfigureMutation(
    owner: SharedRequestOwner,
    runExternalMutation: RuntimeConfigCapability["runExternalMutation"],
    params: Record<string, unknown>,
  ) {
    return runExternalMutation(
      (current) => {
        if (current !== owner.client) {
          throw new Error("Connection changed before the GitHub identity update started.");
        }
        return current.request<ToolsGitHubStatusResult>("tools.github.configure", params);
      },
      {
        canDispatch: () => isCurrent(owner) && configurable,
        dispatchError: "Access changed before the GitHub identity update started.",
      },
    );
  }
  function ensureVerified() {
    if (statusReadable && !(readScope() === "personal" ? personal : status) && !loading && !error) {
      void verify();
    }
  }
  // Admission and drafts are synchronous; this projection only publishes their outcomes.
  const projection = projectMutableSource(deps, () => ({
    status,
    personal,
    system,
    loading,
    busy,
    error,
    statusReadable,
    configurable,
    authorizable,
    scope: readScope(),
    connectionReady: connectionReady(),
    draft: readDraft(),
    authorization: deviceAuthorization.state(),
    authorizationActive: deviceAuthorization.active(),
  }));
  publish = projection.publish;
  onCleanup(release);
  return {
    read: () => ({
      ...projection.read(),
      tokenRevealed: tokenRevealed(),
      patVisible: patVisible(),
    }),
    sync,
    ensureVerified,
    verify,
    setDraft,
    showPatFallback,
    hidePatFallback,
    toggleTokenVisibility,
    startAuthorization,
    cancelAuthorization: deviceAuthorization.cancel,
    configure,
    inherit,
    disconnect,
  };
}

registerGitHubConnectionsEnglish();
