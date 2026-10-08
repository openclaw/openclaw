import { consume } from "@lit/context";
import { createGitHubConnectionsRenderer } from "@openclaw/github/control-ui-identity-api.js";
import { state } from "lit/decorators.js";
import { pathForAgentPanel } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { registerGitHubEnglish } from "../../i18n/locales/en-github.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PROFILE_SETTINGS_TARGET_IDS } from "../../pages/config/settings-targets.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import { githubIdentityHost } from "./github-identity-host.ts";

const renderGitHubConnections = createGitHubConnectionsRenderer(githubIdentityHost);

/** Profile credentials have their own read-scoped lifecycle, independent of users.self edits. */
export class GitHubConnections extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;
  @state() private purpose: "personal" | "system" = "personal";
  @state() private setupOpen = false;
  private snapshot: ApplicationGatewaySnapshot | null = null;
  private revision = 0;
  private canRead = false;
  private canAdmin = false;
  private profileId: string | null = null;
  private subscriptions: Array<() => void> = [];
  private readonly personal = new GitHubIdentityController({
    requestUpdate: () => this.requestUpdate(),
    authorizationSucceeded: () => {
      this.setupOpen = false;
    },
  });
  private readonly system = new GitHubIdentityController({
    requestUpdate: () => this.requestUpdate(),
    authorizationSucceeded: () => {
      this.setupOpen = false;
    },
    runExternalMutation: (task, options) =>
      this.context.runtimeConfig.runExternalMutation(task, options),
  });

  override connectedCallback() {
    super.connectedCallback();
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => this.applySnapshot(snapshot)),
      this.context.agents.subscribe(() => this.syncControllers()),
      this.context.settingsAgentSelection.subscribe(() => this.syncControllers()),
      this.context.runtimeConfig.subscribe(() => this.syncControllers()),
    ];
    this.applySnapshot(this.context.gateway.snapshot);
  }

  override disconnectedCallback() {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.personal.dispose();
    this.system.dispose();
    this.snapshot = null;
    this.revision += 1;
    super.disconnectedCallback();
  }

  private applySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const previous = this.snapshot;
    const changed =
      !previous ||
      previous.client !== snapshot.client ||
      previous.phase !== snapshot.phase ||
      previous.hello !== snapshot.hello ||
      this.profileId !== (snapshot.selfUser?.id ?? null);
    this.snapshot = snapshot;
    this.profileId = snapshot.phase === "connected" ? (snapshot.selfUser?.id ?? null) : null;
    // Access comes from the authenticated connection, never an error from users.github.status.
    this.canRead =
      snapshot.phase === "connected" &&
      Boolean(snapshot.hello?.auth) &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    this.canAdmin = this.canRead && hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (changed) {
      this.revision += 1;
      this.setupOpen = false;
      this.purpose = this.profileId ? "personal" : "system";
    }
    this.syncControllers();
    if (this.canAdmin) {
      void this.context.runtimeConfig.ensureLoaded();
    }
  }

  private syncControllers() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const common = {
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      clientRevision: this.revision,
    };
    this.personal.sync({
      ...common,
      target: this.profileId ? { kind: "personal", profileId: this.profileId } : null,
      statusReadable: this.canRead && this.profileId !== null,
      authorizable: this.canRead && this.profileId !== null,
      configurable: false,
    });
    const agentId = this.context.settingsAgentSelection.state.selectedId;
    this.system.sync({
      ...common,
      target: agentId
        ? {
            kind: "shared",
            scope: "system",
            agentId,
            config: currentConfigObject(this.context.runtimeConfig.state),
          }
        : null,
      statusReadable: this.canAdmin,
      authorizable: this.canAdmin,
      configurable: this.canAdmin,
    });
    if (
      this.personal.statusReadable &&
      !this.personal.personal &&
      !this.personal.loading &&
      !this.personal.error
    ) {
      void this.personal.verify();
    }
    if (
      agentId &&
      this.canAdmin &&
      !this.system.status &&
      !this.system.loading &&
      !this.system.error
    ) {
      void this.system.verify();
    }
    this.requestUpdate();
  }

  private get locked() {
    return (
      this.personal.loading ||
      this.system.loading ||
      this.personal.authorizationActive ||
      this.system.authorizationActive ||
      this.personal.busy ||
      this.system.busy
    );
  }

  private openSetup(purpose: "personal" | "system") {
    if (
      this.locked ||
      (purpose === "personal" ? !this.profileId || !this.canRead : !this.canAdmin)
    ) {
      return;
    }
    this.purpose = purpose;
    this.setupOpen = true;
  }

  override render() {
    const agentId = this.context.settingsAgentSelection.state.selectedId;
    const agent = this.context.agents.state.agentsList?.agents?.find(
      (entry) => entry.id === agentId,
    );
    return renderGitHubConnections({
      personal: this.personal,
      system: this.system,
      purpose: this.purpose,
      setupOpen: this.setupOpen,
      hasProfile: Boolean(this.profileId),
      canRead: this.canRead,
      canAdmin: this.canAdmin,
      locked: this.locked,
      agent: agentId
        ? { id: agentId, label: agent?.identity?.name ?? agent?.name ?? agentId }
        : undefined,
      targetId: PROFILE_SETTINGS_TARGET_IDS.githubConnections,
      onOpenSetup: (purpose) => this.openSetup(purpose ?? (this.profileId ? "personal" : "system")),
      onCloseSetup: () => {
        this.setupOpen = false;
      },
      onOpenAgent: (id) =>
        this.context.navigate("agents", {
          pathname: pathForAgentPanel(id, "tools", this.context.basePath),
        }),
    });
  }
}
if (!customElements.get("openclaw-github-connections")) {
  customElements.define("openclaw-github-connections", GitHubConnections);
}

registerGitHubEnglish();
