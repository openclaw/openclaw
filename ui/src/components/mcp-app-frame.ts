import { type AppBridge, McpUiHostContextSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { collectMcpAppStyleVariables } from "./mcp-app-theme.ts";

registerMcpAppEnglish();

type AddCleanup = (cleanup: () => void) => () => void;
type HostContext = NonNullable<
  NonNullable<ConstructorParameters<typeof AppBridge>[3]>["hostContext"]
>;

export function buildMcpAppFrameHostContext(
  element: Element | undefined,
  height: number,
  fillContainer: boolean,
  displayMode: "inline" | "fullscreen",
  availableDisplayModes: Array<"inline" | "fullscreen">,
): HostContext {
  const rect = element?.getBoundingClientRect();
  const touch = navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)").matches;
  const themeMode = document.documentElement.dataset.themeMode;
  // The SDK schema preserves optional style values while normalizing its complete key map.
  return McpUiHostContextSchema.parse({
    theme:
      themeMode === "light" || themeMode === "dark"
        ? themeMode
        : window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
    displayMode,
    availableDisplayModes,
    containerDimensions: {
      width: Math.max(1, Math.round(rect?.width || window.innerWidth)),
      height: fillContainer ? Math.max(0, Math.round(rect?.height ?? 0)) : height,
    },
    locale: navigator.language || undefined,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: touch && window.innerWidth < 768 ? "mobile" : "web",
    deviceCapabilities: {
      touch,
      hover: window.matchMedia?.("(hover: hover)").matches,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    // Additive alongside `theme`: the string says which appearance is active,
    // these say what it actually resolves to. Republished by the same theme
    // subscription that re-sends this context.
    styles: { variables: collectMcpAppStyleVariables() },
  });
}

export function loadMcpAppSandbox(
  iframe: HTMLIFrameElement,
  url: string,
  addCleanup: AddCleanup,
): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(t("mcpApp.errors.sandboxTimedOut")));
    }, 15_000);
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === iframe.contentWindow &&
        event.data?.method === "ui/notifications/sandbox-proxy-ready"
      ) {
        cleanup();
        resolve();
      }
    };
    const cleanup = addCleanup(() => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    });
    window.addEventListener("message", onMessage);
  });
  iframe.src = url;
  return ready;
}

export async function waitForMcpAppInitialization(
  initialized: Promise<void>,
  addCleanup: AddCleanup,
): Promise<void> {
  let timeout: number | undefined;
  const cleanup = addCleanup(() => {
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
    }
  });
  try {
    await Promise.race([
      initialized,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(
          () => reject(new Error(t("mcpApp.errors.initializationTimedOut"))),
          15_000,
        );
      }),
    ]);
  } finally {
    cleanup();
  }
}

export async function waitForMcpAppHandlerRegistration(): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    }),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 1_000);
    }),
  ]);
}
