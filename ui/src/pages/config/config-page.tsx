import "../../styles/config.css";
import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import { hasNativeBrowserBridge } from "../../app/native-browser-host.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import {
  SettingsPageHeader,
  LearnMoreLink,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createConfigPage } from "./config-page-state.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { Mcp, McpIntro } from "./mcp.tsx";
import { MeetingCaptureSettings } from "./meeting-capture.tsx";
import { MemorySettingsPage } from "./memory-page.tsx";
import { memorySettingsSchema } from "./memory-schema.ts";
import type { ConfigRouteData } from "./route-data.ts";
import { extractQuickSettingsSecurity, Security } from "./security.tsx";
import { SessionStorageSettings } from "./session-storage.tsx";
import { TalkSettingsPage } from "./talk-page.tsx";
import { UpdatesPage } from "./updates-page.tsx";
import type { ConfigProps } from "./view-types.ts";
import { Config } from "./view.tsx";
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
  state: ReturnType<typeof createConfigPage>;
  pageId: ConfigPageId;
  routeData: ConfigRouteData | null;
  config: ConfigProps;
  configObject: Record<string, unknown>;
}) {
  const context = () => props.state.application();
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
              mutationDisabled={props.state.mutationDisabled()}
              advancedExpanded={
                props.config.forceAdvancedSection === "session" ||
                props.routeData?.targetBlockId === "config-section-session"
              }
              buildEditor={() => editor}
            />
          </Show>
        }
      >
        <MeetingCaptureSettings
          mutationDisabled={props.state.mutationDisabled()}
          advancedExpanded={
            props.config.forceAdvancedSection === "transcripts" ||
            props.routeData?.targetBlockId === "config-section-transcripts"
          }
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
      <SettingsToggleRow
        title={t("browserLinkPreferences.openInControlUi")}
        checked={props.config.openLinksInControlUiBrowser === true}
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
          nowMs={props.state.nowMs()}
          configBusy={props.state.mutationDisabled()}
          updateBusy={props.state.updateBusy()}
          statusRead={props.state.updates.read()}
          onCheckStatus={props.state.updates.refresh}
          captureCommandPresentation={props.state.updates.captureCommandPresentation}
        />
      </Show>
      <Show when={props.pageId === "memory"}>
        <MemorySettingsPage
          configObject={props.configObject}
          mutationDisabled={props.state.mutationDisabled()}
          pluginsHref={pathForRoute("plugins", context().basePath)}
          memoryImportHref={pathForRoute("memory-import", context().basePath)}
          routeData={props.routeData}
          admittedRoute={props.state.admittedRoute}
          buildEditor={() =>
            editor("memory", t("tabs.memory"), memorySettingsSchema(config().schema))
          }
        />
      </Show>
      <Show when={props.pageId === "talk"}>
        <TalkSettingsPage
          presentationRetired={props.config.presentationRetired}
          configObject={props.configObject}
          mutationDisabled={props.state.mutationDisabled()}
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
          configBusy={props.state.mutationDisabled()}
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

export function ConfigPage(props: ConfigPageProps) {
  let host!: HTMLElement;
  const context = useApplication();
  const state = createConfigPage(
    context,
    () => ({ pageId: props.pageId, routeData: props.routeData }),
    () => host,
  );
  return (
    <openclaw-config-page ref={(element) => (host = element)}>
      <Show when={props.pageId !== "memory"}>
        <SettingsPageHeader
          title={titleForRoute(props.pageId, t)}
          subtitle={renderConfigPageSubtitle(props.pageId)}
        />
      </Show>
      <SettingsWorkspace>
        <ConfigBody
          state={state}
          pageId={props.pageId}
          routeData={props.routeData}
          config={state.configProps()}
          configObject={state.configObject()}
        />
      </SettingsWorkspace>
    </openclaw-config-page>
  );
}

export type ConfigPageRouteData = ConfigRouteData & { pageId: ConfigPageId };

// Keep renderer identity shared across subpages so route changes preserve this owner.
export function ConfigRoute(props: SolidRouteProps<ConfigPageRouteData>) {
  return (
    <Show when={props.data}>
      {(data) => <ConfigPage pageId={data().pageId} routeData={data()} />}
    </Show>
  );
}
