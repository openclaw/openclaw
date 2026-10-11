import "../../styles/config.css";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  useContext,
  untrack,
} from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { hasNativeBrowserBridge } from "../../app/native-browser-host.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { shellLayoutOwnerForHost } from "../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../app/shell-layout-traits-solid.tsx";
import { subscribeLobsterdex } from "../../components/lobster-dex.ts";
import { SettingsPageHeader, LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import {
  projectNativeDeviceSettings,
  projectNativeNotifications,
} from "../../lib/reactive/application-native.ts";
import {
  projectGateway,
  projectAgentSelection,
  projectApplicationConfig,
  projectOverlays,
  projectWebPush,
} from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import {
  projectRuntimeConfig,
  projectAgents,
  projectAgentIdentity,
} from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { BrowserLinkPreferencesRow } from "./browser-link-preferences.tsx";
import { ConfigPageController, extractQuickSettingsSecurity } from "./config-page.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { Mcp, McpIntro } from "./mcp.tsx";
import { MeetingCaptureSettings } from "./meeting-capture.tsx";
import { MemorySettingsPage } from "./memory-page.tsx";
import { memorySettingsSchema } from "./memory-schema.ts";
import type { ConfigRouteData } from "./route-data.ts";
import { Security } from "./security.tsx";
import { SessionStorageSettings } from "./session-storage.tsx";
import { TalkSettingsPage } from "./talk-page.tsx";
import { UpdatesPage } from "./updates-page.tsx";
import type { ConfigProps } from "./view-types.ts";
import { Config } from "./view.tsx";
export { ConfigPageController, extractQuickSettingsSecurity } from "./config-page.ts";
export type { ConfigPageId } from "./config-sections.ts";

function renderConfigPageSubtitle(pageId: ConfigPageId) {
  switch (pageId) {
    case "appearance":
      return (
        <>
          {t("configView.appearance.intro")}{" "}
          <LearnMoreLink url="https://docs.openclaw.ai/web/control-ui" />
        </>
      );
    case "mcp":
      return <McpIntro />;
    case "security":
      return (
        <>
          {t("quickSettings.security.intro")}{" "}
          <LearnMoreLink url="https://docs.openclaw.ai/gateway/security" />
        </>
      );
    case "talk":
      return (
        <>
          {t("talkPage.intro")} <LearnMoreLink url="https://docs.openclaw.ai/nodes/talk" />
        </>
      );
    case "updates":
      return t("updates.page.intro");
    default:
      return subtitleForRoute(pageId);
  }
}

function ConfigBody(props: {
  controller: ConfigPageController;
  pageId: ConfigPageId;
  routeData: ConfigRouteData | null;
  config: ConfigProps;
  configObject: Record<string, unknown>;
}) {
  const context = () => props.controller.application;
  const renderSection = (editor: JSX.Element) => (
    <>
      <Show
        when={props.pageId === "communications" && props.config.activeSection === "transcripts"}
        fallback={
          <Show
            when={props.pageId === "ai-agents" && props.config.activeSection === "session"}
            fallback={editor}
          >
            <SessionStorageSettings
              mutationDisabled={props.controller.mutationDisabled}
              advancedExpanded={props.config.forceAdvancedSection === "session"}
              buildEditor={() => editor}
            />
          </Show>
        }
      >
        <MeetingCaptureSettings
          mutationDisabled={props.controller.mutationDisabled}
          advancedExpanded={props.config.forceAdvancedSection === "transcripts"}
          buildEditor={() => editor}
        />
      </Show>
    </>
  );
  const prelude = (
    <Show
      when={
        props.config.activeSection === "browser" &&
        isBrowserPanelAvailable(context().gateway.snapshot) &&
        !hasNativeBrowserBridge()
      }
    >
      <BrowserLinkPreferencesRow
        enabled={props.controller.browserLinksEnabled}
        onChange={(enabled) =>
          props.config.onAppearanceChange({ openLinksInControlUiBrowser: enabled })
        }
      />
    </Show>
  );
  const config = createMemo(() => ({ ...props.config, renderSection, sectionPrelude: prelude }));
  const editor = (section: string, label: string, schema = config().schema) => (
    <Config
      {...config()}
      schema={schema}
      activeSection={section}
      activeSubsection={null}
      showModeToggle={false}
      embeddedEditor
      navRootLabel={label}
    />
  );
  return (
    <>
      <Show when={props.pageId === "updates"}>
        <UpdatesPage
          context={context()}
          configObject={props.configObject}
          nowMs={props.controller.nowMs}
          configBusy={props.controller.mutationDisabled}
          updateBusy={props.controller.updateBusy}
        />
      </Show>
      <Show when={props.pageId === "memory"}>
        <MemorySettingsPage
          configObject={props.configObject}
          mutationDisabled={props.controller.mutationDisabled}
          pluginsHref={pathForRoute("plugins", context().basePath)}
          memoryImportHref={pathForRoute("memory-import", context().basePath)}
          routeData={props.routeData}
          buildEditor={() =>
            editor("memory", t("tabs.memory"), memorySettingsSchema(config().schema))
          }
        />
      </Show>
      <Show when={props.pageId === "talk"}>
        <TalkSettingsPage
          configObject={props.configObject}
          mutationDisabled={props.controller.mutationDisabled}
          buildEditor={() => editor("talk", t("tabs.talk"))}
        />
      </Show>
      <Show when={props.pageId === "mcp"}>
        <Mcp
          configObject={props.configObject}
          pluginsHref={pathForRoute("plugins", context().basePath)}
          editor={editor("mcp", "MCP")}
        />
      </Show>
      <Show when={props.pageId === "security"}>
        <Security
          security={extractQuickSettingsSecurity(props.configObject)}
          configBusy={props.controller.mutationDisabled}
          canPairDevice={
            context().runtimeConfig.state.connected &&
            hasOperatorAdminAccess(context().gateway.snapshot.hello?.auth ?? null)
          }
          onPairMobile={() => void context().overlays.openDevicePairSetup()}
          onBrowserEnabledToggle={(enabled) =>
            enabled
              ? context().runtimeConfig.removeFormValue(["browser", "enabled"])
              : context().runtimeConfig.patchForm(["browser", "enabled"], false)
          }
          onToolProfileChange={(profile) =>
            context().runtimeConfig.patchForm(["tools", "profile"], profile)
          }
          editor={<Config {...config()} embeddedEditor />}
        />
      </Show>
      <Show when={!["updates", "memory", "talk", "mcp", "security"].includes(props.pageId)}>
        <Config {...config()} />
      </Show>
    </>
  );
}

export type ConfigPageProps = { pageId: ConfigPageId; routeData: ConfigRouteData | null };

function ConfigPageContent(props: ConfigPageProps & { host: HTMLElement }) {
  const host = untrack(() => props.host);
  const context = useApplication();
  // Plain controllers can notify while a descendant or bridge owns the current scope.
  const [revision, publish] = createSignal(0, { ownedWrite: true });
  const controller = new ConfigPageController(
    context,
    () => publish((value) => value + 1),
    revision,
  );
  const gateway = projectGateway(context.gateway);
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const selection = projectAgentSelection(context.settingsAgentSelection);
  const agentSelection = projectAgentSelection(context.agentSelection);
  const agents = projectAgents(context.agents);
  const identities = projectAgentIdentity({
    identities: context.agentIdentity,
    agentId: context.agentSelection.state.selectedId,
  });
  const config = projectApplicationConfig(context.config);
  const overlays = projectOverlays(context.overlays);
  const webPush = projectWebPush(context.webPush);
  const theme = projectTheme(context.theme);
  const nativeDevice = context.nativeDeviceSettings
    ? projectNativeDeviceSettings(context.nativeDeviceSettings)
    : null;
  const nativeNotifications = context.nativeNotifications
    ? projectNativeNotifications(context.nativeNotifications)
    : null;
  const refresh = () => {
    controller.synchronize();
    publish((value) => value + 1);
  };
  const subscriptions = [
    gateway,
    runtime,
    selection,
    agentSelection,
    agents,
    identities,
    config,
    overlays,
    webPush,
    theme.preferences,
    nativeDevice,
    nativeNotifications,
  ].flatMap((source) => (source ? [source.subscribe(refresh)] : []));
  subscriptions.push(subscribeLobsterdex(refresh));
  createEffect(
    () => [props.pageId ?? "advanced", props.routeData ?? null] as const,
    ([pageId, routeData]) => controller.updateRoute(pageId, routeData),
  );
  onSettled(() => {
    controller.connect(host);
    return () => controller.dispose();
  });
  onCleanup(() => {
    for (const stop of subscriptions) {
      stop();
    }
  });
  const configProps = createMemo(() => {
    revision();
    return controller.configProps;
  });
  const configObject = createMemo(() => {
    revision();
    return controller.configObject;
  });
  createEffect(revision, () => controller.afterCommit());
  const inheritedLayout = useContext(ShellLayoutProvider);
  const layoutOwner = shellLayoutOwnerForHost(host);
  const layout = inheritedLayout ?? (layoutOwner ? { owner: layoutOwner, host } : null);
  return (
    <ShellLayoutProvider value={layout}>
      <Show when={(props.pageId ?? "advanced") !== "memory"}>
        <SettingsPageHeader
          title={titleForRoute(props.pageId ?? "advanced")}
          subtitle={renderConfigPageSubtitle(props.pageId ?? "advanced")}
        />
      </Show>
      <SettingsWorkspace>
        <ConfigBody
          controller={controller}
          pageId={props.pageId ?? "advanced"}
          routeData={props.routeData ?? null}
          config={configProps()}
          configObject={configObject()}
        />
      </SettingsWorkspace>
    </ShellLayoutProvider>
  );
}

// The bridge owns the single host for both the Lit route and Solid callers.
export const ConfigPage = defineSolidBridge<ConfigPageProps>(
  "openclaw-config-page",
  (props, host) => <ConfigPageContent {...props} host={host} />,
  {
    properties: {
      pageId: { default: "advanced", attribute: "page-id" },
      routeData: { default: null, attribute: false },
    },
  },
);
