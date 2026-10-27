import type { ControlUiReadiness } from "../app/control-ui-readiness.ts";
import type { TooltipElement } from "../components/tooltip.ts";
import type { ControlUiMockGateway } from "./control-ui-e2e-contract.ts";

// Playwright serializes this function; keep runtime dependencies inside its body.
export function readControlUiE2eBrowserState() {
  const copy = (value: unknown): unknown => {
    try {
      return structuredClone(value) as unknown;
    } catch {
      return String(value);
    }
  };
  const windowState = window as Window & {
    __OPENCLAW_CONTROL_UI_E2E_LONG_FRAMES__?: () => unknown[];
    __OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__?: unknown[];
    openclawControlUiE2eGateway?: Partial<
      Pick<ControlUiMockGateway, "requests" | "socketStates" | "socketUrls">
    >;
  };
  const query = (selector: string, root: ParentNode | null = document) =>
    root?.querySelector<HTMLElement>(selector) ?? null;
  const queryAll = (selector: string) => [...document.querySelectorAll(selector)];
  const app = query("openclaw-app");
  const shell = query("openclaw-app-shell");
  const runInspector = query("#activity-run-panel");
  const diagnostics: ReturnType<ControlUiReadiness["hook"]["diagnostics"]> | undefined =
    window.openclawControlUi?.diagnostics();
  const readiness = window.openclawControlUi?.snapshot();
  const agentsState = diagnostics?.roster;
  const gatewaySnapshot = diagnostics?.gateway;
  const customElementCounts: Record<string, number> = {};
  for (const element of queryAll("*")) {
    const name = element.localName;
    if (!name.includes("-")) {
      continue;
    }
    customElementCounts[name] = (customElementCounts[name] ?? 0) + 1;
  }
  const textarea = document.querySelector<HTMLTextAreaElement>(
    ".agent-chat__composer-combobox textarea",
  );
  const roster =
    agentsState?.agentsList && typeof agentsState.agentsList === "object"
      ? (agentsState.agentsList as { agents?: unknown })
      : null;
  const send = document.querySelector<HTMLButtonElement>(".chat-send-btn--send");
  const stop = document.querySelector<HTMLButtonElement>(".chat-send-btn--stop");
  // Structural facts identify keyboard/overlay ownership without exposing content or IDs.
  const describeElement = (element: Element | null) =>
    element
      ? {
          kind:
            element instanceof HTMLTextAreaElement
              ? "textarea"
              : element instanceof HTMLButtonElement
                ? "button"
                : element instanceof HTMLInputElement
                  ? "input"
                  : element === document.body
                    ? "body"
                    : "other",
          inComposer: Boolean(element.closest(".agent-chat__input")),
          isStop: element === stop,
          isSend: element === send,
        }
      : null;
  const openTooltips = [...document.querySelectorAll<TooltipElement>("openclaw-tooltip[open]")];
  const sendLabel = send?.getAttribute("aria-label");
  // Submit-disabled labels can contain server errors. Only known static UI copy
  // may reach CI logs; private reports retain the existing detailed state.
  const safeValue = (value: unknown, allowed: string[]) =>
    allowed.find((entry) => entry === value) ?? "unknown";
  const nullableBoolean = (value: unknown) => (typeof value === "boolean" ? value : null);
  const agentPage = query("openclaw-agents-page");
  const agentProperty = (key: string) => (agentPage ? Reflect.get(agentPage, key) : undefined);
  const selectedAgent = agentProperty("agentsSelectedId");
  const fileList = agentProperty("agentFilesList");
  const fileEditor = document.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
  const agentPath = window.location.pathname.match(
    /^\/settings\/agents\/([^/]+)\/(overview|files|tools|skills|channels|cron)$/u,
  );
  const groupElement = (part: string, root: ParentNode | null = document) =>
    query(`.session-group-defaults__${part}`, root);
  const groupMode = groupElement("mode-dropdown");
  const groupMenu = groupElement("mode-menu", groupMode);
  const groupFolderPicker = groupElement("folder-popover");
  return {
    failureSummary: {
      readiness: readiness
        ? {
            generation: readiness.generation,
            booted: readiness.booted,
            gatewayPhase: readiness.gatewayPhase,
            routeReady: readiness.routeReady,
            rosterReady: readiness.rosterReady,
            ready: readiness.ready,
            settlementFailed: diagnostics?.settlementError != null,
          }
        : null,
      markdownTables: {
        dialogDefined: customElements.get("openclaw-modal-dialog") !== undefined,
        expandButtons: queryAll(".chat-thread .markdown-table__expand").length,
        focusedExpandButton: document.activeElement?.matches(".markdown-table__expand") ?? false,
        modals: queryAll("openclaw-modal-dialog.markdown-table-modal")
          .slice(0, 4)
          .map((host) => {
            const dialog = host.querySelector("dialog");
            return {
              hostOpen: nullableBoolean(Reflect.get(host, "open")),
              inTranscript: host.closest(".chat-thread") !== null,
              nativePresent: dialog !== null,
              nativeOpen: dialog?.open ?? null,
              inTopLayer: dialog?.matches(":modal") ?? null,
              visible: dialog?.checkVisibility({ visibilityProperty: true }) ?? null,
              rectCount: dialog?.getClientRects().length ?? 0,
              labelMatchesHost: dialog?.getAttribute("aria-label") === Reflect.get(host, "label"),
            };
          }),
      },
      sessionGroupDefaults: groupMode
        ? {
            open: groupMenu?.matches(":popover-open") ?? false,
            expanded: safeValue(
              groupElement("mode-trigger", groupMode)?.getAttribute("aria-expanded"),
              ["true", "false"],
            ),
            menuInert: groupMenu?.inert ?? null,
            menuVisible: groupMenu?.checkVisibility({ visibilityProperty: true }) ?? null,
            folderPickerOpen: groupFolderPicker?.matches(":popover-open") ?? null,
            items: ["local", "worktree"].map((value) => {
              const item = query(`[data-environment-mode="${value}"]`, groupMode);
              return {
                value,
                present: Boolean(item),
                role: safeValue(item?.getAttribute("role"), [
                  "menuitem",
                  "menuitemcheckbox",
                  "menuitemradio",
                ]),
                visible: item?.checkVisibility({ visibilityProperty: true }) ?? null,
                rectCount: item?.getClientRects().length ?? 0,
                iconCount: item?.querySelectorAll(".oc-menu-item__icon").length ?? 0,
              };
            }),
          }
        : null,
      canvasWidgets: queryAll("openclaw-canvas-widget-view")
        .slice(0, 8)
        .map((widget) => ({
          loading: Boolean(widget.querySelector(".skeleton")),
          errorPresent: Boolean(widget.querySelector('[role="alert"]')),
          framePresent: Boolean(widget.querySelector(".chat-tool-card__preview-frame")),
        })),
      agentFiles: {
        pathname: agentPath ? `/settings/agents/:agent/${agentPath[2]}` : "other",
        pagePresent: Boolean(agentPage),
        selectedAgentPresent: typeof selectedAgent === "string" && selectedAgent.length > 0,
        selectionMatchesPath: agentPath ? selectedAgent === agentPath[1] : null,
        listMatchesSelection: fileList ? fileList.agentId === selectedAgent : null,
        panel: safeValue(agentProperty("agentsPanel"), [
          "overview",
          "files",
          "tools",
          "skills",
          "channels",
          "cron",
        ]),
        activeFile: safeValue(agentProperty("agentFileActive"), [
          "AGENTS.md",
          "SOUL.md",
          "USER.md",
          "BOOTSTRAP.md",
          "MEMORY.md",
          "IDENTITY.md",
          "TOOLS.md",
          "HEARTBEAT.md",
        ]),
        loading: agentPage ? agentProperty("agentFilesLoading") === true : null,
        editorPresent: Boolean(fileEditor),
        editorLength: fileEditor?.value.length ?? null,
        editorDisabled: fileEditor?.disabled ?? null,
      },
      runInspector: {
        panelPresent: runInspector !== null,
        executionIdentityPresent: runInspector?.hasAttribute("data-execution-id") ?? null,
        runIdentityPresent: runInspector?.hasAttribute("data-run-id") ?? null,
      },
      gatewayPhase: safeValue(gatewaySnapshot?.phase, [
        "stopped",
        "connecting",
        "connected",
        "offline",
        "reconnecting",
        "starting",
        "reload-required",
      ]),
      connected: nullableBoolean(agentsState?.connected),
      roster: {
        loading: nullableBoolean(agentsState?.agentsLoading),
        count: Array.isArray(roster?.agents) ? roster.agents.length : null,
        errorPresent: Boolean(agentsState?.agentsError),
      },
      longFrames: copy(windowState["__OPENCLAW_CONTROL_UI_E2E_LONG_FRAMES__"]?.() ?? null),
      documentReadyState: safeValue(document.readyState, ["loading", "interactive", "complete"]),
      providerStatuses: queryAll(".model-providers__head .settings-status")
        .slice(0, 8)
        .map((badge) => {
          const text = badge.textContent?.trim();
          return {
            status: safeValue(text, ["Ready", "Signed in", "Configured", "Failed"]),
            length: text?.length ?? 0,
          };
        }),
      activeElement: describeElement(document.activeElement),
      tooltips: {
        openCount: openTooltips.length,
        entries: openTooltips.slice(0, 8).map((tooltip) => {
          const trigger =
            tooltip.anchor ?? tooltip.querySelector("button, input, textarea, [tabindex]");
          return {
            trigger: describeElement(trigger),
            hovered: tooltip.matches(":hover") || (trigger?.matches(":hover") ?? false),
            containsFocus:
              tooltip.contains(document.activeElement) ||
              (trigger?.contains(document.activeElement) ?? false),
          };
        }),
      },
      composer: textarea
        ? {
            draftLength: textarea.value.length,
            nonempty: textarea.value.length > 0,
            disabled: textarea.disabled,
            stop: stop
              ? {
                  visible: stop.checkVisibility({ visibilityProperty: true }),
                  disabled: stop.disabled,
                  focused: stop === document.activeElement,
                }
              : null,
            send: send
              ? {
                  label: safeValue(sendLabel, [
                    "Send message",
                    "Write a message to send.",
                    "Sending message...",
                    "Loading chat",
                  ]),
                  labelLength: sendLabel?.length ?? 0,
                  disabled: send.disabled,
                  busy: send.getAttribute("aria-busy") === "true",
                }
              : null,
          }
        : null,
    },
    app: copy(diagnostics ?? null),
    document: {
      customElementCounts,
      hasApp: Boolean(app),
      hasShell: Boolean(shell),
      readyState: document.readyState,
      // Resource timing omits stalled fetches; compare it with the script sources.
      completedResources: performance
        .getEntriesByType("resource")
        .filter((entry) => /\.(?:js|css)(?:\?|$)/u.test(entry.name))
        .map((entry) => ({
          duration: Math.round(entry.duration),
          name: entry.name,
        })),
      scripts: [...document.scripts].map((script) => script.src || "(inline)"),
      serviceWorkerController: navigator.serviceWorker?.controller?.state ?? null,
      title: document.title,
      url: window.location.href,
    },
    mockGateway: {
      installed: Boolean(windowState.openclawControlUiE2eGateway),
      requests: copy(windowState.openclawControlUiE2eGateway?.requests ?? []),
      socketStates: copy(windowState.openclawControlUiE2eGateway?.socketStates?.() ?? []),
      socketUrls: copy(windowState.openclawControlUiE2eGateway?.socketUrls?.() ?? []),
    },
    unhandledRejections: copy(
      windowState["__OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__"] ?? [],
    ),
  };
}
