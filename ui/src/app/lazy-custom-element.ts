import { createChangeListeners } from "../../../src/shared/listeners.js";
import { t } from "../i18n/index.ts";
import {
  isStaleChunkImportError,
  cancelStaleChunkRecovery,
  retryStaleChunkReloadWhenReachable,
} from "./stale-chunk-reload.ts";

type CustomElementModuleLoader = () => Promise<unknown>;

const pendingLoads = new Map<string, Promise<void>>();

/** Load a custom-element module once and verify that it registered its tag. */
export function ensureCustomElementDefined(
  tagName: string,
  loadModule: CustomElementModuleLoader,
): Promise<void> {
  if (customElements.get(tagName)) {
    return Promise.resolve();
  }
  const pending = pendingLoads.get(tagName);
  if (pending) {
    return pending;
  }
  const load = Promise.resolve()
    .then(loadModule)
    .then(() => {
      if (!customElements.get(tagName)) {
        throw new Error(`Custom element module did not define ${tagName}`);
      }
    })
    .finally(() => {
      pendingLoads.delete(tagName);
    });
  pendingLoads.set(tagName, load);
  return load;
}

export type OptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: CustomElementModuleLoader;
};

type RenderHost = {
  readonly updateComplete?: Promise<unknown>;
  /**
   * Render-root lookup used to gate action replay on the element actually
   * being rendered. Hosts without it replay unconditionally.
   */
  queryRenderedElement?: (tagName: string) => Element | null;
};

type LazyCustomElementRequestState =
  | { status: "loading"; element: OptionalCustomElement }
  | {
      status: "error";
      element: OptionalCustomElement;
      error: unknown;
      stale: boolean;
    };

type LazyCustomElementRequest = LazyCustomElementRequestState & {
  action?: () => void;
};

/** Owns visible lazy-element requests while global registration stays deduplicated by tag. */
export function createLazyCustomElementRequests(
  host: RenderHost = {},
  onClose?: () => void,
  retryStale = (canReload: () => boolean) => retryStaleChunkReloadWhenReachable({ canReload }),
) {
  let current: LazyCustomElementRequest | undefined;
  const preloads = new Set<string>();
  let activeElement: OptionalCustomElement | undefined;
  let activeDismissed = false;
  let staleRetry: LazyCustomElementRequest | undefined;
  const listeners = createChangeListeners();
  const notify = listeners.publish;

  function preload(element: OptionalCustomElement, options?: { reportError?: boolean }): void {
    if (isOptionalElementDefined(element) || preloads.has(element.tagName)) {
      return;
    }
    preloads.add(element.tagName);
    void ensureCustomElementDefined(element.tagName, element.loadModule)
      .then(
        () => notify(),
        (error: unknown) => {
          if (options?.reportError && !current) {
            current = {
              element,
              error,
              stale: isStaleChunkImportError(error),
              status: "error",
            };
            notify();
          }
        },
      )
      .finally(() => preloads.delete(element.tagName));
  }

  function requestElement(element: OptionalCustomElement, action?: () => void): void {
    const request = {
      action,
      element,
      status: "loading",
    } satisfies LazyCustomElementRequest;
    current = request;
    notify();
    load(request);
  }

  function requestWhileActive(element: OptionalCustomElement, active: boolean): void {
    if (active) {
      if (activeElement !== element) {
        activeElement = element;
        activeDismissed = false;
      }
    } else if (activeElement === element) {
      activeElement = undefined;
      activeDismissed = false;
    }
    if (!active && current?.element === element) {
      abandon();
    } else {
      pumpActive();
    }
  }

  function retry(): void {
    const request = current;
    if (request?.status !== "error") {
      return;
    }
    const retryRequest = {
      action: request.action,
      element: request.element,
      status: "loading",
    } satisfies LazyCustomElementRequest;
    current = retryRequest;
    staleRetry = request.stale ? retryRequest : undefined;
    notify();
    const canReload = () => current === retryRequest;
    void (request.stale ? retryStale(canReload) : Promise.resolve(false)).then((reloading) => {
      if (!reloading && current === retryRequest) {
        load(retryRequest);
      }
    });
  }

  function close(): void {
    if (current) {
      if (current.element === activeElement) {
        activeDismissed = true;
      }
      onClose?.();
      abandon();
    }
  }

  function abandon(): void {
    if (current) {
      // A retired stale-chunk failure must not reload the page later (#130988);
      // surfaces that still show a failure re-arm recovery when they render.
      if ((current.status === "error" && current.stale) || current === staleRetry) {
        cancelStaleChunkRecovery();
      }
      current = undefined;
      notify();
      pumpActive();
    }
  }

  function pumpActive(): void {
    if (activeElement && !activeDismissed && !current && !isOptionalElementDefined(activeElement)) {
      requestElement(activeElement);
    }
  }

  function load(request: LazyCustomElementRequest): void {
    void ensureCustomElementDefined(request.element.tagName, request.element.loadModule).then(
      async () => {
        // Registration outlives dismissal; mount the closed element so the next open works.
        notify();
        if (current !== request) {
          return;
        }
        await host.updateComplete;
        if (current === request) {
          // Replay only once the host has actually rendered the element.
          // During boot the shell can still be splash-gated after this update;
          // replaying then re-dispatches an event nothing handles, which
          // re-enters this loader in a microtask cycle that starves the
          // render (and the Gateway socket) forever. The skipped action stays
          // persisted as the pending lazy shell action and replays through
          // restorePendingLazyAction on a later context update.
          const replayable =
            !host.queryRenderedElement ||
            host.queryRenderedElement(request.element.tagName) !== null;
          if (replayable) {
            request.action?.();
          }
          if (current === request) {
            abandon();
          }
        }
      },
      (error: unknown) => {
        if (current !== request) {
          return;
        }
        current = {
          action: request.action,
          element: request.element,
          error,
          stale: isStaleChunkImportError(error),
          status: "error",
        };
        notify();
      },
    );
  }

  return {
    get visibleState(): LazyCustomElementRequestState | undefined {
      return current;
    },
    subscribe: listeners.subscribe,
    preload,
    request: requestElement,
    requestWhileActive,
    retry,
    close,
    abandon,
  };
}

export type LazyCustomElementRequests = ReturnType<typeof createLazyCustomElementRequests>;

export const COMMAND_PALETTE_ELEMENT = {
  tagName: "openclaw-command-palette",
  label: "command palette",
  loadModule: () => import("../components/command-palette.tsx"),
} satisfies OptionalCustomElement;

export const DEBUG_OVERLAY_ELEMENT = {
  tagName: "openclaw-debug-overlay",
  get label() {
    return t("debug.overlay.title");
  },
  loadModule: () => import("../pages/debug/debug-overlay.ts"),
} satisfies OptionalCustomElement;

export const KEYBOARD_SHORTCUTS_ELEMENT = {
  tagName: "openclaw-keyboard-shortcuts-dialog",
  get label() {
    return t("shortcutsOverlay.title");
  },
  loadModule: () => import("../components/keyboard-shortcuts-dialog.tsx"),
} satisfies OptionalCustomElement;

const APP_SIDEBAR_TAG = "openclaw-app-sidebar";

export const APP_SIDEBAR_ELEMENT = {
  tagName: APP_SIDEBAR_TAG,
  label: APP_SIDEBAR_TAG,
  loadModule: () => import("../components/app-sidebar.tsx"),
} satisfies OptionalCustomElement;

const MACOS_TITLEBAR_TAG = "openclaw-macos-titlebar-controls";

export const MACOS_TITLEBAR_ELEMENT = {
  tagName: MACOS_TITLEBAR_TAG,
  label: MACOS_TITLEBAR_TAG,
  loadModule: () => import("../components/macos-titlebar-controls.runtime-solid.tsx"),
} satisfies OptionalCustomElement;

export const SIDEBAR_ATTENTION_ELEMENT = {
  tagName: "openclaw-sidebar-attention",
  label: t("attention.issues"),
  loadModule: () => import("../components/sidebar-attention.tsx"),
} satisfies OptionalCustomElement;

export const TERMINAL_PANEL_ELEMENT = {
  tagName: "openclaw-terminal-panel",
  label: "terminal panel",
  loadModule: () => import("../components/terminal/terminal-panel-registration.ts"),
} satisfies OptionalCustomElement;

export const BROWSER_PANEL_ELEMENT = {
  tagName: "openclaw-browser-panel",
  label: "browser panel",
  loadModule: () => import("../components/browser/browser-panel.ts"),
} satisfies OptionalCustomElement;

export const BROWSER_DOCUMENT_ELEMENT = {
  tagName: "openclaw-browser-document",
  label: BROWSER_PANEL_ELEMENT.label,
  loadModule: () => import("../components/browser/browser-document.ts"),
} satisfies OptionalCustomElement;

export const DESKTOP_PANEL_ELEMENT = {
  tagName: "openclaw-desktop-panel",
  label: "desktop panel",
  loadModule: () => import("../components/desktop/desktop-panel.ts"),
} satisfies OptionalCustomElement;

export const LINK_READER_PANEL_ELEMENT = {
  tagName: "openclaw-link-reader-panel",
  get label() {
    return t("linkReader.title");
  },
  loadModule: () => import("../components/link-reader-panel.tsx"),
} satisfies OptionalCustomElement;

export const DASHBOARD_DOCUMENT_ELEMENT = {
  tagName: "openclaw-board-document",
  label: "dashboard document",
  loadModule: () => import("../components/board/board-document.tsx"),
} satisfies OptionalCustomElement;

// Loaded only for approval document URLs: the approval page pulls the protocol
// validators (typebox runtime) and must stay out of the normal startup graph.
export const APPROVAL_PAGE_ELEMENT = {
  tagName: "openclaw-approval-page",
  label: "approval page",
  loadModule: () => import("../pages/approval/approval-page-registration.ts"),
} satisfies OptionalCustomElement;

const QUESTION_PAGE_TAG = "openclaw-question-page";

export const QUESTION_PAGE_ELEMENT = {
  tagName: QUESTION_PAGE_TAG,
  label: QUESTION_PAGE_TAG,
  loadModule: () => import("../pages/question/question-page-registration.ts"),
} satisfies OptionalCustomElement;

// The card is in the chat graph, but modal-only queue controls stay off the
// startup path until an approval is actually pending.
export const EXEC_APPROVAL_ELEMENT = {
  tagName: "openclaw-exec-approval",
  get label() {
    return t("tabs.approvals");
  },
  loadModule: () => import("../components/exec-approval-solid.tsx"),
} satisfies OptionalCustomElement;

export function isOptionalElementDefined(element: OptionalCustomElement): boolean {
  return customElements.get(element.tagName) !== undefined;
}

export const LOGIN_GATE_ELEMENT = {
  tagName: "openclaw-login-gate",
  label: "login screen",
  loadModule: () => import("../components/login-gate.ts"),
} satisfies OptionalCustomElement;
