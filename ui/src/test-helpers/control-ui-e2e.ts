// Control UI test helper supports control ui e2e setup.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HelloOk } from "@openclaw/gateway-protocol";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { Locator, Page } from "playwright";
import type { InlineConfig, Plugin, PreviewServer, ViteDevServer } from "vite";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import { controlUiPluginAssetRoot } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import type {
  AgentsListResult,
  ModelCatalogEntry,
  UpdateAvailable,
  UpdateScheduleState,
} from "../api/types.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { createControlUiAttachmentFacts } from "./control-ui-attachment-fixtures.ts";
import { createControlUiE2eBuildPublication } from "./control-ui-e2e-build-publication.ts";
import type {
  ControlUiMockGateway,
  ControlUiMockRequestHandler,
  MockGatewayControls,
  MockGatewayRequest,
  MockGatewayWindow,
} from "./control-ui-e2e-contract.ts";
import { createMockGatewayControls } from "./control-ui-e2e-controls.ts";
import {
  defaultControlUiFeatureMethods,
  createControlUiThemeResponses,
} from "./control-ui-e2e-defaults.ts";
import {
  installControlUiE2ePageDiagnosticRing,
  installControlUiE2eUnhandledRejectionRing,
} from "./control-ui-e2e-diagnostics.ts";
import { resolveAvailableLoopbackPort } from "./control-ui-e2e-port.ts";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e-readiness.ts";
import { createControlUiMockResponses } from "./control-ui-mock-responses.ts";
import type { NativeControlUiPluginFixture } from "./control-ui-plugin-fixture.ts";
import {
  createControlUiSessionFixtures,
  type ControlUiSessionFixture,
} from "./control-ui-session-fixtures.ts";

export type {
  ControlUiMockGateway,
  ControlUiMockRequestHandler,
  MockGatewayControls,
  MockGatewayRequest,
  MockGatewayWindow,
} from "./control-ui-e2e-contract.ts";

export {
  captureControlUiE2eFailureDiagnostics,
  installControlUiRpcDiagnostics,
} from "./control-ui-e2e-diagnostics.ts";
export { controlUiE2eWaitTimeoutMs, waitForConfirmModal } from "./control-ui-e2e-readiness.ts";

export function controlUiSessionPath(
  sessionKey: string,
  basePath = "",
  namespace: "chat" | "dashboard" = "chat",
): string {
  const pathname = buildControlUiSessionPath({
    namespace,
    sessionKey,
    fallbackAgentId: sessionKey.split(":")[1] || "main",
    basePath,
    shortIdLength: 32,
  });
  return pathname ?? `${basePath}/chat`;
}

export function controlUiSessionUrl(
  baseUrl: string,
  sessionKey: string,
  namespace: "chat" | "dashboard" = "chat",
): string {
  const url = new URL(baseUrl);
  // Cold fixture navigation knows the exact key; it must not depend on a warm
  // short-reference cache or a separately mocked sessions.resolve response.
  url.pathname =
    buildControlUiSessionPath({
      namespace,
      sessionKey,
      basePath: url.pathname,
      fallbackAgentId: sessionKey.split(":")[1] || "main",
      exactKey: true,
    }) ?? controlUiSessionPath(sessionKey, url.pathname, namespace);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function assertSessionSectionCountAlignment(
  page: Page,
  sectionIds: readonly string[],
) {
  const sections = sectionIds.map((sectionId) =>
    page.locator(`[data-session-section="${sectionId}"]`),
  );
  for (const section of sections) {
    const toggle = section.locator(".sidebar-session-group-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "false") {
      await toggle.click();
    }
  }
  const rightEdges = await Promise.all(
    sections.map(async (section) => {
      const bounds = await section.locator(".sidebar-session-group-count").boundingBox();
      if (!bounds) {
        throw new Error("Expected visible collapsed section count");
      }
      return bounds.x + bounds.width;
    }),
  );
  const expected = rightEdges[0];
  if (expected === undefined || rightEdges.some((edge) => Math.abs(edge - expected) > 0.1)) {
    throw new Error(`Expected aligned section count edges, received ${rightEdges.join(", ")}`);
  }
  for (const [index, sectionId] of sectionIds.entries()) {
    const section = sections[index];
    if (!section || !sectionId.startsWith("catalog:")) {
      continue;
    }
    const header = section.locator(":scope > .sidebar-recent-sessions__head");
    await header.hover();
    const count = header.locator(".sidebar-session-group-count");
    const countBox = await count.boundingBox();
    const countOpacity = await count.evaluate((element) => getComputedStyle(element).opacity);
    if (!countBox || Number.parseFloat(countOpacity) <= 0) {
      throw new Error("Expected visible catalog count on hover");
    }
    const actionBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const action of await header.locator(".sidebar-session-group-actions").all()) {
      const actionBox = await action.boundingBox();
      if (!actionBox || actionBox.x + actionBox.width > countBox.x) {
        throw new Error("Expected catalog hover actions to stay left of the count");
      }
      actionBoxes.push(actionBox);
    }
    actionBoxes.sort((left, right) => left.x - right.x);
    if (
      actionBoxes.some((box, actionIndex) => {
        const previous = actionBoxes[actionIndex - 1];
        return previous ? box.x < previous.x + previous.width : false;
      })
    ) {
      throw new Error("Expected catalog hover actions not to overlap");
    }
    const contentBoxes = await Promise.all(
      (
        await header
          .locator(
            ".sidebar-recent-sessions__label-text, .session-run-spinner, .session-unread-dot",
          )
          .all()
      ).map((element) => element.boundingBox()),
    );
    const contentRight = Math.max(...contentBoxes.map((box) => (box ? box.x + box.width : 0)));
    if (contentRight > (actionBoxes[0]?.x ?? Number.POSITIVE_INFINITY)) {
      throw new Error("Expected catalog content to stay left of hover actions");
    }
    const groupingAction = header.locator("[data-session-catalog-view-menu]");
    await groupingAction.click();
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-session-section="${id}"] [data-session-catalog-view-menu]`)
          ?.getAttribute("aria-expanded") === "true",
      sectionId,
    );
    await page.mouse.move(0, 0);
    const persistentOpacity = await groupingAction.evaluate(
      (element) => getComputedStyle(element).opacity,
    );
    if (Number.parseFloat(persistentOpacity) <= 0) {
      throw new Error("Expected an open catalog action to remain visible without hover");
    }
    await page.keyboard.press("Escape");
    await section.locator(".sidebar-session-group-toggle").click();
    for (const nestedCount of await section
      .locator(".sidebar-session-catalog-host__count, .sidebar-session-catalog-project__count")
      .all()) {
      const nestedBounds = await nestedCount.boundingBox();
      const textAlign = await nestedCount.evaluate(
        (element) => getComputedStyle(element).textAlign,
      );
      if (
        !nestedBounds ||
        textAlign !== "right" ||
        Math.abs(nestedBounds.x + nestedBounds.width - expected) > 0.1
      ) {
        throw new Error("Expected expanded catalog counts to share the section count edge");
      }
    }
    await section.locator(".sidebar-session-group-toggle").click();
  }
}

export async function navigateToControlUiSession(page: Page, sessionKey: string): Promise<void> {
  const expectedPathname = await page.evaluate((sessionPath) => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        context: {
          basePath: string;
          navigate: (routeId: string, options: { pathname: string }) => void;
        };
      };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    const pathname = `${app.runtime.context.basePath}${sessionPath}`;
    const url = new URL(window.location.href);
    url.pathname = pathname;
    app.runtime.context.navigate("chat", { pathname });
    return url.pathname;
  }, controlUiSessionPath(sessionKey));
  await page.waitForURL((url) => url.pathname === expectedPathname);
  await page.waitForFunction(
    (targetSessionKey) =>
      [...document.querySelectorAll<HTMLElement>("openclaw-chat-pane")].some(
        (pane) =>
          pane.classList.contains("chat-pane-cache__pane--visible") &&
          (pane as HTMLElement & { sessionKey?: string }).sessionKey === targetSessionKey,
      ),
    sessionKey,
  );
}

export function controlUiBundledGatewayUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function controlUiBundledSettingsStorageKey(baseUrl: string): string {
  return `openclaw.control.settings.v1:${controlUiBundledGatewayUrl(baseUrl)}`;
}

export function createControlUiMockSameOriginGatewayScript(): string {
  return `;(${installControlUiMockSameOriginGateway.toString()})();`;
}

function installControlUiMockSameOriginGateway() {
  // Standalone mock pages emulate Gateway-served UI so same-origin security
  // checks exercise package assets instead of falling back to initials.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  (
    window as Window & {
      ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string };
    }
  )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
    gatewayUrl: `${protocol}//${window.location.host}`,
  };
}

type ControlUiRouteTarget = {
  hash?: string;
  pathname?: string;
  pathnamePrefix?: string;
  routeId: string;
  search?: string;
};

// Cold Vite route chunks can monopolize Chromium on loaded CI hosts. Keep the
// wait browser-local, but allow enough time for the router to finish committing.
const CONTROL_UI_ROUTE_TIMEOUT_MS = 60_000;

/**
 * Wait for the browser router to commit a route, not merely update the URL.
 * Browser-local polling keeps readiness independent of host-side CDP scheduling.
 */
export async function waitForControlUiRoute(page: Page, target: ControlUiRouteTarget) {
  try {
    const handle = await page.waitForFunction(
      (expected) => {
        const app = document.querySelector<
          HTMLElement & {
            runtime?: {
              router: {
                getState: () => {
                  status: string;
                  resolvedLocation: { pathname: string } | null;
                  matches: { routeId: string }[];
                  pendingMatches: unknown[];
                };
              };
            };
          }
        >("openclaw-app");
        // Native popup events can arrive before the app element is parsed.
        const state = app?.runtime?.router.getState();
        const pathname = window.location.pathname;
        // Router paths retain literal characters that browser history percent-encodes.
        // Serialize as a pathname; decoding would alias encoded delimiters and percent data.
        const browserPathname = (value: string) => {
          const url = new URL(window.location.href);
          url.pathname = value;
          return url.pathname;
        };
        return (
          state?.status === "success" &&
          state.matches[0]?.routeId === expected.routeId &&
          state.resolvedLocation !== null &&
          browserPathname(state.resolvedLocation.pathname) === pathname &&
          state.pendingMatches.length === 0 &&
          (expected.pathname === undefined || pathname === browserPathname(expected.pathname)) &&
          (expected.pathnamePrefix === undefined ||
            pathname.startsWith(browserPathname(expected.pathnamePrefix))) &&
          (expected.search === undefined || window.location.search === expected.search) &&
          (expected.hash === undefined || window.location.hash === expected.hash)
        );
      },
      target,
      { timeout: CONTROL_UI_ROUTE_TIMEOUT_MS },
    );
    await handle.dispose();
  } catch (error) {
    const state = await page.evaluate(() => {
      const app = document.querySelector<
        HTMLElement & {
          runtime?: {
            router: {
              getState: () => unknown;
            };
          };
        }
      >("openclaw-app");
      return {
        hash: window.location.hash,
        pathname: window.location.pathname,
        router: app?.runtime?.router.getState() ?? null,
        search: window.location.search,
      };
    });
    throw new Error(
      `Control UI route did not settle at ${JSON.stringify(target)}; current state: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
}

/**
 * Click a control inside a board widget document once pointer events reach it.
 *
 * Board widget frames stay `inert` and transparent until the sandbox reports
 * the document rendered, and Linux Chromium keeps routing pointer events to the
 * outer iframe element instead of into the revealed cross-origin document until
 * that reveal reaches its compositor. Playwright's actionability checks read the
 * DOM, and its hit-target interceptor reports a click that reached no frame as
 * delivered, so a click issued in that window is a silent no-op. Hover until the
 * widget document itself observes the pointer, then click; a control that never
 * observes it fails loudly instead.
 */
export async function clickBoardWidgetControl(page: Page, control: Locator): Promise<void> {
  const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
  for (;;) {
    // Leave and re-enter: a stationary pointer keeps the browser's stale
    // routing decision, while a fresh move re-runs hit testing.
    await page.mouse.move(0, 0);
    await control.hover();
    if (await control.evaluate((element) => element.matches(":hover"))) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error("Board widget control never received pointer events.");
    }
    await page.waitForTimeout(100);
  }
  await control.click();
}

export async function waitForControlUiSettingsTakeover(
  page: Page,
  pathname = "/settings/appearance",
): Promise<{ search: Locator; sidebar: Locator }> {
  await waitForControlUiRoute(page, { pathname, routeId: "appearance" });
  const appSidebar = page.locator("openclaw-app-sidebar");
  const sidebar = page.locator(".settings-sidebar");
  const search = sidebar.getByRole("searchbox", { name: "Search settings" });
  await appSidebar.waitFor({ state: "detached" });
  await search.waitFor({ state: "visible" });
  return { search, sidebar };
}

const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");
const json5BrowserSource = readFileSync(require.resolve("json5/dist/index.min.js"), "utf8");

export { defaultControlUiFeatureMethods } from "./control-ui-e2e-defaults.ts";

export type ControlUiMockGatewayScenario = {
  nativePlugins?: readonly NativeControlUiPluginFixture[];
  pluginAssetsRequireAuth?: boolean;
  attachmentMaxBytes?: number;
  agentModel?: string | null;
  assistantAgentId?: string;
  assistantName?: string;
  automaticallyFetchFavicons?: boolean;
  communityInvite?: boolean;
  /** Only invitation behavior tests opt into a fresh visitor; visual proofs keep it dismissed. */
  communityInviteDismissed?: boolean;
  basePath?: string;
  controlUiTabs?: Array<{
    group?: string;
    icon?: string;
    id: string;
    label: string;
    path?: string;
    placement?: string;
    pluginId: string;
    slug?: string;
  }>;
  controlUiLinkReaders?: unknown[];
  controlUiWidgetKinds?: Array<{
    kind: string;
    label: string;
    pluginId: string;
  }>;
  allowedSessionVisibilities?: Array<"shared" | "read-only" | "suggest" | "draft">;
  hasMultipleSessionSharingIdentities?: boolean;
  featureCapabilities?: string[];
  connectCapabilities?: string[];
  defaultAgentId?: string;
  deferredMethods?: string[];
  /** Hold every request until resolveDeferred/rejectDeferred releases the method. */
  heldMethods?: string[];
  /** Non-release gateway checkout branch surfaced in the sidebar footer. */
  devGitBranch?: string;
  /** Exact immutable Control UI artifact served by the mocked Gateway. */
  serverBuildId?: string;
  /** Exact Gateway lifecycle generation served in hello. */
  gatewayBootId?: string;
  gatewaySuspensionPhase?: "accepting" | "preparing" | "draining" | "prepared";
  /** Optional startup update snapshot for rich local mock fixtures. */
  updateAvailable?: UpdateAvailable | null;
  /** Optional automatic-update campaign snapshot for rich local mock fixtures. */
  updateSchedule?: UpdateScheduleState | null;
  controlUiBuildSource?: "bundled" | "configured";
  serverVersion?: string;
  deviceToken?: string;
  authMethod?: HelloOk["auth"]["method"];
  authMode?: HelloOk["snapshot"]["authMode"] | null;
  featureMethods?: string[];
  /** Simulate a legacy Gateway that predates the advertised method catalog. */
  omitFeatureMethods?: boolean;
  historyMessages?: unknown[];
  /** Canonical per-session transcripts, shared by history and startup reads. */
  sessionTranscripts?: Record<
    string,
    {
      messages: unknown[];
      thinkingLevel?: string | null;
      inFlightRun?: ControlUiMockGatewayScenario["inFlightRun"];
    }
  >;
  maxPayload?: number;
  /** Static payloads, parameter-matched cases, or call-ordered sequences. */
  methodResponses?: Record<string, unknown>;
  /** URL prefixes that retain the browser's real WebSocket transport. */
  webSocketPassthroughPrefixes?: string[];
  /** Replayed in-flight run snapshot served by chat.history and chat.startup. */
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    events?: unknown[];
    plan?: unknown;
  } | null;
  /** Online users included in the connect snapshot's presence list. The entry
   * flagged `self` adopts the connecting client's instanceId so presence
   * surfaces (footer facepile, who's-online roster) resolve "you". */
  presenceUsers?: Array<{
    self?: boolean;
    id: string;
    identity?: AuthenticatedUser["identity"];
    name?: string;
    email?: string;
    avatarUrl?: string;
    deviceFamily?: string;
    host?: string;
    ip?: string;
    instanceId?: string;
    lastInputSeconds?: number;
    onlineSince?: number;
    lastActivityAt?: number;
    timeZone?: string;
    mode?: string;
    platform?: string;
    ts?: number;
    watchedSessions?: string[];
  }>;
  /** Subscription-scoped Gateway events replayed on a fixed browser-side cycle. */
  repeatingSessionEvents?: {
    events: Array<{ event: "agent" | "session.observer" | "session.tool"; payload: unknown }>;
    intervalMs?: number;
  };
  /** Explicit history-only row override, for example a stale run-state projection. */
  sessionInfo?: Record<string, unknown> | null;
  /** Canonical fixture rows, independent of case/sequence/deferred wire overrides. */
  sessions?: ControlUiSessionFixture[];
  /** Partition sessions.list fixtures by archived state after applying patches. */
  sessionArchiveFiltering?: boolean;
  models?: ModelCatalogEntry[];
  /** Simulate a legacy Gateway whose connect hello predates the auth projection. */
  omitConnectHelloAuth?: boolean;
  /** Operator scopes returned by the mocked connect handshake. */
  operatorScopes?: string[];
  /** Selected fixture and event default; use controlUiSessionUrl to select it in the UI. */
  sessionKey?: string;
  sessionScope?: AgentsListResult["scope"];
  mainSessionKey?: string;
  /** Initial gateway-owned custom group catalog (sessions.groups.*), in order. */
  sessionGroups?: string[];
  /** Optional New Session defaults keyed by custom group name. */
  sessionGroupDefaults?: Record<string, { cwd?: string; worktree?: boolean }>;
  terminalEnabled?: boolean;
  cliAgentsEnabled?: boolean;
  workspace?: string;
  workspaceGit?: boolean;
};

type NormalizedControlUiMockGatewayScenario = Required<
  Omit<ControlUiMockGatewayScenario, "nativePlugins">
>;

const DEFAULT_MOCK_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_MOCK_ATTACHMENT_MAX_BYTES = Math.floor(
  ((DEFAULT_MOCK_MAX_PAYLOAD_BYTES - 256 * 1024) * 3) / 4,
);

export type ControlUiE2eServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export type ControlUiE2eProductionServer = ControlUiE2eServer & {
  replaceBuild: (nextDir: string, previousDir: string) => Promise<void>;
};

type ControlUiE2eServerOptions = {
  source?: boolean;
};

const DEFAULT_CONTROL_UI_E2E_BUILD_INFO: ControlUiBuildInfo = {
  version: "2026.7.10",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-07-10T11:22:33.000Z",
  builtAt: "2026-07-10T12:34:56.000Z",
  branch: null,
  dirty: false,
  release: false,
  buildId: "e2e",
};

let sharedControlUiE2eServerBaseUrl: string | null = null;

export function setSharedControlUiE2eServerBaseUrl(baseUrl: string | null): void {
  sharedControlUiE2eServerBaseUrl = baseUrl;
}

export async function reconnectMockGateway(
  page: Page,
  gateway: MockGatewayControls,
  bootId?: string,
): Promise<void> {
  const socketCount = await gateway.getSocketCount();
  if (bootId) {
    await gateway.setGatewayBootId(bootId);
  }
  await gateway.closeLatest(1001, "mock Gateway restart");
  await gateway.setOnline(false);
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime?: { context: { gateway: { snapshot: { phase: string } } } };
      };
      return app.runtime?.context.gateway.snapshot.phase === "reconnecting";
    },
    undefined,
    { timeout: controlUiE2eWaitTimeoutMs },
  );
  await page.waitForFunction(
    (previousSocketCount) =>
      ((window as MockGatewayWindow).openclawControlUiE2eGateway?.socketCount() ?? 0) >
      previousSocketCount,
    socketCount,
    { timeout: controlUiE2eWaitTimeoutMs },
  );
  await gateway.setOnline(true);
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime?: { context: { gateway: { snapshot: { phase: string } } } };
      };
      return app.runtime?.context.gateway.snapshot.phase === "connected";
    },
    undefined,
    { timeout: controlUiE2eWaitTimeoutMs },
  );
}

const chromiumExecutableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
export const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function resolveRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

export function resolvePlaywrightChromiumExecutablePath(
  defaultExecutablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  canRun: (chromiumExecutablePath: string) => boolean = canRunPlaywrightChromium,
): string {
  const executableOverride = env[chromiumExecutableOverrideEnvKey]?.trim();
  if (executableOverride) {
    return executableOverride;
  }
  if (canRun(defaultExecutablePath)) {
    return defaultExecutablePath;
  }
  return (
    systemChromiumExecutableCandidates.find((candidate) => canRun(candidate)) ??
    defaultExecutablePath
  );
}

export function canRunPlaywrightChromium(chromiumExecutablePath: string): boolean {
  if (!existsSync(chromiumExecutablePath)) {
    return false;
  }
  return spawnSync(chromiumExecutablePath, ["--version"], { stdio: "ignore" }).status === 0;
}

// Pause an installed virtual clock slightly ahead of its current time so
// elapsed time advances only through clock.runFor/fastForward. Without this,
// page.clock.install() keeps ticking at real-time rate, and slow runners break
// assertions that a virtual deadline has or has not elapsed yet (#115187). The
// headroom keeps the pauseAt target ahead of the still-ticking clock between
// the Date.now() read and the pause; jumping to it fires nothing relevant.
export async function pauseVirtualClock(page: Page): Promise<void> {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
}

export async function startControlUiE2eServer(
  buildInfo?: ControlUiBuildInfo,
  options: ControlUiE2eServerOptions = {},
): Promise<ControlUiE2eServer> {
  // Ordinary E2E files exercise the shipped bundle. Source-module and custom
  // build-info tests retain a private Vite server through the same lease API.
  if (
    sharedControlUiE2eServerBaseUrl !== null &&
    buildInfo === undefined &&
    options.source !== true
  ) {
    return {
      baseUrl: sharedControlUiE2eServerBaseUrl,
      close: async () => {},
    };
  }
  const resolvedBuildInfo = normalizeControlUiBuildInfo(
    buildInfo ?? DEFAULT_CONTROL_UI_E2E_BUILD_INFO,
  );
  // Shared browser fixtures import this helper; load filesystem-bound Vite
  // configuration only when its Node-owned development server actually starts.
  const [
    { createServer },
    { controlUiLocaleModulesPlugin },
    {
      commonJsOptimizeDeps,
      controlUiBrowserOnlySharedModuleAliases,
      resolveExternalPackageAliasesForVite,
      resolveSourcePackageAliasesForVite,
      resolveTsconfigPathAliasesForVite,
    },
  ] = await Promise.all([
    import("vite"),
    import("../../config/control-ui-locales.ts"),
    import("../../vite.config.ts"),
  ]);
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const port = await resolveAvailableLoopbackPort();
  const server = await createServer({
    base: "/",
    cacheDir: path.join(repoRoot, ".artifacts", "control-ui-e2e-vite"),
    clearScreen: false,
    configFile: false,
    define: {
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(resolvedBuildInfo),
    },
    logLevel: "error",
    optimizeDeps: {
      include: [
        "ipaddr.js",
        "lit/directives/repeat.js",
        "markdown-it-task-lists",
        ...commonJsOptimizeDeps,
      ],
    },
    publicDir: path.join(uiRoot, "public"),
    plugins: [controlUiLocaleModulesPlugin(), controlUiBrowserOnlySharedModuleAliases()],
    resolve: {
      alias: [
        { find: "json5", replacement: json5EsmPath },
        ...resolveExternalPackageAliasesForVite(),
        ...resolveSourcePackageAliasesForVite(),
        ...resolveTsconfigPathAliasesForVite(),
      ],
    },
    root: uiRoot,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  });
  await server.listen(port);
  return {
    baseUrl: resolveServerBaseUrl(server),
    close: () => server.close(),
  };
}

// Mirror the Gateway's depth-insensitive asset resolution
// (src/gateway/control-ui.ts): any "/assets/" segment serves the bundled
// asset. The built index.html uses portable relative asset URLs, so a
// document reloaded on a deep link like /chat/research requests
// /chat/assets/*.js; without this contract Vite's SPA fallback answers with
// index.html and the module never executes, bricking the page.
function controlUiE2eGatewayAssetPathPlugin(): Plugin {
  return {
    name: "control-ui-e2e-gateway-asset-paths",
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const assetsIndex = url.indexOf("/assets/");
        if (assetsIndex > 0) {
          req.url = url.slice(assetsIndex);
        }
        next();
      });
    },
  };
}

function controlUiE2ePreviewConfigPlugin(
  bootstrapConfig: Record<string, unknown> = {
    basePath: "/",
    assistantName: "",
    assistantAvatar: "",
    communityInvite: true,
  },
): Plugin {
  return {
    name: "control-ui-e2e-preview-config",
    configurePreviewServer(server) {
      server.middlewares.use(CONTROL_UI_BOOTSTRAP_CONFIG_PATH, (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(bootstrapConfig));
      });
    },
  };
}

function createBundledControlUiE2eConfig(
  controlUiViteConfig: (options: { outDir?: string }) => InlineConfig,
  outDir: string,
): InlineConfig {
  const config = controlUiViteConfig({ outDir });
  const uiRoot = path.join(resolveRepoRoot(), "ui");
  return {
    ...config,
    base: "/",
    configFile: false,
    define: {
      ...config.define,
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(
        DEFAULT_CONTROL_UI_E2E_BUILD_INFO,
      ),
    },
    logLevel: "error" as const,
    root: uiRoot,
  };
}

export async function buildProductionControlUiE2e(outDir: string, buildId: string): Promise<void> {
  // Keep the production config outside Vitest, but write directly to the
  // caller-owned output so concurrent E2E builds cannot replace its worker.
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    OPENCLAW_CONTROL_UI_BUILD_ID: buildId,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) {
      delete env[key];
    }
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--production-build", outDir],
    {
      cwd: uiRoot,
      encoding: "utf8",
      env,
      // Forward build activity while spawnSync waits; retain stderr for failures.
      stdio: ["ignore", "inherit", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Production Control UI build failed (exit ${result.status ?? "unknown"}):\n${result.stderr || result.error?.message || "See streamed build output above."}`,
    );
  }
}

async function runProductionControlUiBuild(outDir: string): Promise<void> {
  const [{ build }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  await build({
    ...controlUiViteConfig({ outDir }),
    configFile: false,
    logLevel: "info",
    root: path.join(resolveRepoRoot(), "ui"),
  });
}

async function startBuiltControlUiE2eServer(
  outDir: string,
  bootstrapConfig?: Record<string, unknown>,
): Promise<ControlUiE2eProductionServer> {
  const [{ preview }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  const port = await resolveAvailableLoopbackPort();
  const sharedConfig = createBundledControlUiE2eConfig(controlUiViteConfig, outDir);
  const publication = createControlUiE2eBuildPublication(outDir);
  const server = await preview({
    ...sharedConfig,
    plugins: [
      publication.plugin,
      ...(sharedConfig.plugins ?? []),
      controlUiE2eGatewayAssetPathPlugin(),
      controlUiE2ePreviewConfigPlugin(bootstrapConfig),
    ],
    preview: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  });
  try {
    return {
      baseUrl: resolveServerBaseUrl(server),
      close: () => server.close(),
      replaceBuild: publication.replaceBuild,
    };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

export async function startBundledControlUiE2eServer(outDir: string): Promise<ControlUiE2eServer> {
  const [{ build }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  await build({
    ...createBundledControlUiE2eConfig(controlUiViteConfig, outDir),
    logLevel: "info",
  });
  return startBuiltControlUiE2eServer(outDir);
}

export async function startProductionControlUiE2eServer(
  outDir: string,
  buildId: string,
  bootstrapConfig?: Record<string, unknown>,
): Promise<ControlUiE2eProductionServer> {
  await buildProductionControlUiE2e(outDir, buildId);
  return startBuiltControlUiE2eServer(outDir, bootstrapConfig);
}

function resolveServerBaseUrl(server: ViteDevServer | PreviewServer): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI E2E server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}/`;
}

function normalizeScenario(
  scenario: ControlUiMockGatewayScenario,
): NormalizedControlUiMockGatewayScenario {
  const defaultAgentId = normalizeAgentId(scenario.defaultAgentId);
  const mainSessionKey =
    scenario.mainSessionKey?.trim() ||
    (scenario.sessionScope === "global" ? "global" : `agent:${defaultAgentId}:main`);
  const sessionKey = scenario.sessionKey?.trim() || mainSessionKey;
  const staticList = scenario.methodResponses?.["sessions.list"] as
    | { sessions?: ControlUiSessionFixture[] }
    | undefined;
  const basePathValue = scenario.basePath?.trim() ?? "";
  const basePathWithSlash = basePathValue
    ? basePathValue.startsWith("/")
      ? basePathValue
      : `/${basePathValue}`
    : "";
  const basePath =
    basePathWithSlash.length > 1 && basePathWithSlash.endsWith("/")
      ? basePathWithSlash.slice(0, -1)
      : basePathWithSlash;
  return {
    pluginAssetsRequireAuth: scenario.pluginAssetsRequireAuth ?? true,
    attachmentMaxBytes: scenario.attachmentMaxBytes ?? DEFAULT_MOCK_ATTACHMENT_MAX_BYTES,
    automaticallyFetchFavicons: scenario.automaticallyFetchFavicons ?? false,
    communityInvite: scenario.communityInvite ?? true,
    communityInviteDismissed: scenario.communityInviteDismissed ?? true,
    agentModel:
      scenario.agentModel === undefined ? "openai/gpt-5.5" : scenario.agentModel?.trim() || null,
    assistantAgentId: scenario.assistantAgentId?.trim() || defaultAgentId,
    assistantName: scenario.assistantName?.trim() || "OpenClaw",
    basePath,
    controlUiTabs: scenario.controlUiTabs ?? [],
    controlUiWidgetKinds: scenario.controlUiWidgetKinds ?? [],
    controlUiLinkReaders: scenario.controlUiLinkReaders ?? [],
    allowedSessionVisibilities: scenario.allowedSessionVisibilities ?? [
      "shared",
      "read-only",
      "suggest",
      "draft",
    ],
    hasMultipleSessionSharingIdentities: scenario.hasMultipleSessionSharingIdentities ?? false,
    featureCapabilities: scenario.featureCapabilities ?? [],
    connectCapabilities: scenario.connectCapabilities ?? [
      GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT,
    ],
    defaultAgentId,
    deferredMethods: scenario.deferredMethods ?? [],
    heldMethods: scenario.heldMethods ?? [],
    devGitBranch: scenario.devGitBranch?.trim() || "",
    serverBuildId: scenario.serverBuildId?.trim() || "e2e",
    gatewayBootId: scenario.gatewayBootId?.trim() || "e2e-gateway-boot",
    gatewaySuspensionPhase: scenario.gatewaySuspensionPhase ?? "accepting",
    updateAvailable: scenario.updateAvailable ?? null,
    updateSchedule: scenario.updateSchedule ?? null,
    controlUiBuildSource: scenario.controlUiBuildSource ?? "bundled",
    serverVersion: scenario.serverVersion?.trim() || "e2e",
    deviceToken: scenario.deviceToken?.trim() || "e2e-device-token",
    authMethod: scenario.authMethod ?? "token",
    authMode: scenario.authMode ?? null,
    // Baseline scenarios represent a current Gateway. Tests for unsupported or
    // mixed-version methods provide an explicit narrower catalog.
    featureMethods: scenario.featureMethods ?? [...defaultControlUiFeatureMethods],
    omitFeatureMethods: scenario.omitFeatureMethods ?? false,
    historyMessages: scenario.historyMessages ?? [],
    sessionTranscripts: scenario.sessionTranscripts ?? {},
    maxPayload: scenario.maxPayload ?? DEFAULT_MOCK_MAX_PAYLOAD_BYTES,
    mainSessionKey,
    methodResponses: { ...createControlUiThemeResponses(), ...scenario.methodResponses },
    webSocketPassthroughPrefixes: scenario.webSocketPassthroughPrefixes ?? [],
    inFlightRun: scenario.inFlightRun ?? null,
    presenceUsers: scenario.presenceUsers ?? [],
    models: scenario.models ?? [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
    omitConnectHelloAuth: scenario.omitConnectHelloAuth ?? false,
    operatorScopes: scenario.operatorScopes ?? [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ],
    repeatingSessionEvents: scenario.repeatingSessionEvents ?? { events: [] },
    sessionInfo: scenario.sessionInfo ?? null,
    sessions:
      scenario.sessions ??
      staticList?.sessions ??
      (staticList
        ? []
        : [
            {
              key: sessionKey === "main" ? mainSessionKey : sessionKey,
              label: "Main",
              kind:
                (sessionKey === "main" ? mainSessionKey : sessionKey) === "global"
                  ? "global"
                  : "direct",
              updatedAt: Date.now(),
            },
          ]),
    sessionArchiveFiltering: scenario.sessionArchiveFiltering ?? false,
    sessionKey,
    sessionScope: scenario.sessionScope ?? "per-sender",
    sessionGroups: scenario.sessionGroups ?? [],
    sessionGroupDefaults: scenario.sessionGroupDefaults ?? {},
    terminalEnabled: scenario.terminalEnabled ?? false,
    cliAgentsEnabled: scenario.cliAgentsEnabled ?? false,
    workspace: scenario.workspace ?? "",
    workspaceGit: scenario.workspaceGit ?? false,
  };
}

export function createControlUiMockBootstrapConfig(scenario: ControlUiMockGatewayScenario = {}) {
  const normalizedScenario = normalizeScenario(scenario);
  const nativeCatalog = normalizedScenario.methodResponses["plugins.controlUi.list"] as
    | { plugins?: { pluginId: string }[] }
    | undefined;
  return {
    pluginAssetsRequireAuth: normalizedScenario.pluginAssetsRequireAuth,
    pluginFrameGrants: (normalizedScenario.pluginAssetsRequireAuth
      ? (nativeCatalog?.plugins ?? [])
      : []
    ).map(({ pluginId }) => ({
      pluginId,
      path: `/__openclaw__/plugins/control-ui/${encodeURIComponent(pluginId)}/`,
      match: "prefix",
    })),
    allowExternalEmbedUrls: false,
    automaticallyFetchFavicons: normalizedScenario.automaticallyFetchFavicons,
    communityInvite: normalizedScenario.communityInvite,
    assistantAgentId: normalizedScenario.assistantAgentId,
    assistantAvatar: "",
    assistantName: normalizedScenario.assistantName,
    basePath: normalizedScenario.basePath,
    devGitBranch: normalizedScenario.devGitBranch || undefined,
    embedSandbox: "scripts",
    serverVersion: normalizedScenario.serverVersion,
    serverBuildId: normalizedScenario.serverBuildId,
    terminalEnabled: normalizedScenario.terminalEnabled,
    cliAgentsEnabled: normalizedScenario.cliAgentsEnabled,
  };
}

export function createControlUiMockGatewayInitScript(
  scenario: ControlUiMockGatewayScenario = {},
): string {
  const input = {
    protocolVersion: PROTOCOL_VERSION,
    scenario: normalizeScenario(scenario),
  };
  return `${json5BrowserSource}\n;(() => { const __name = (target) => target; (${installControlUiMockGateway.toString()})(${JSON.stringify(input)}, globalThis.JSON5.parse, ${createControlUiSessionFixtures.toString()}, ${createControlUiAttachmentFacts.toString()}, ${createControlUiMockResponses.toString()}); })();`;
}

function installControlUiMockGateway(
  input: {
    protocolVersion: number;
    scenario: NormalizedControlUiMockGatewayScenario;
  },
  parseJson5: (raw: string) => unknown,
  createSessions: typeof createControlUiSessionFixtures,
  createAttachmentFacts: typeof createControlUiAttachmentFacts,
  createResponses: typeof createControlUiMockResponses,
) {
  const NativeWebSocket = window.WebSocket;
  type BrowserFrame = {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    type?: unknown;
  };
  type DeferredResponse = {
    id: string;
    method: string;
    params?: unknown;
    socket: { deliver: (frame: unknown) => void };
  };
  type DeferredMethod = {
    method: string;
    match?: Record<string, unknown>;
  };
  type MockTerminalSession = {
    sessionId: string;
    agentId: string;
    shell: string;
    cwd: string;
    confined: boolean;
    attached: boolean;
    owner: "conn";
    createdAtMs: number;
    buffer: string;
    seq: number;
  };

  const scenario = input.scenario;
  if (scenario.communityInviteDismissed) {
    try {
      // Same persisted preference as community-invite-state.ts, before the first sidebar render.
      window.localStorage.setItem(
        "openclaw:control-ui:community-invite",
        JSON.stringify({ dismissedAtMs: 1770000000000 }),
      );
    } catch {
      // The product already suppresses the invitation when storage is unavailable.
    }
  }
  const serverBuildIdStateKey = "openclaw.control-ui-e2e.serverBuildId";
  let serverBuildId = scenario.serverBuildId;
  let gatewayBootId =
    new URL(window.location.href).searchParams.get("mockGatewayBootId")?.trim() ||
    scenario.gatewayBootId;
  try {
    serverBuildId = window.sessionStorage.getItem(serverBuildIdStateKey)?.trim() || serverBuildId;
  } catch {
    // The scenario value remains authoritative when browser storage is unavailable.
  }
  (window as MockGatewayWindow)["__OPENCLAW_CONTROL_UI_BASE_PATH__"] = scenario.basePath;
  const protocolVersion = input.protocolVersion;
  const methodResponseOverridesStorageKey = "openclaw.control-ui-e2e.method-responses.v1";
  const canonicalSessionsStorageKey = "openclaw.control-ui-e2e.canonical-sessions.v1";
  const methodResponseOverrides: Record<string, unknown> = {};
  try {
    const storedOverrides = window.sessionStorage.getItem(methodResponseOverridesStorageKey);
    const parsedOverrides = storedOverrides ? (JSON.parse(storedOverrides) as unknown) : null;
    if (isRecord(parsedOverrides)) {
      Object.assign(methodResponseOverrides, parsedOverrides);
      Object.assign(scenario.methodResponses, parsedOverrides);
    }
  } catch {
    // Opaque initial documents may not expose storage; the target page will.
  }
  const deferredMethods: DeferredMethod[] = scenario.deferredMethods.map((method) => ({ method }));
  const heldMethods = new Set(scenario.heldMethods);
  const deferredResponses: DeferredResponse[] = [];
  const requests: MockGatewayRequest[] = [];
  const requestHandlers = new Map<string, ControlUiMockRequestHandler>();
  const pendingApprovals = new Map<string, Map<string, Record<string, unknown>>>();
  let canonicalSessionRows = scenario.sessions;
  let hasCanonicalSessionsOverride = false;
  try {
    const storedCanonicalSessions = window.sessionStorage.getItem(canonicalSessionsStorageKey);
    const parsedCanonicalSessions = storedCanonicalSessions
      ? (JSON.parse(storedCanonicalSessions) as unknown)
      : null;
    if (Array.isArray(parsedCanonicalSessions)) {
      canonicalSessionRows = parsedCanonicalSessions as ControlUiSessionFixture[];
      hasCanonicalSessionsOverride = true;
    }
  } catch {
    // The scenario remains authoritative when browser storage is unavailable.
  }
  const sessions = createSessions(
    {
      rows: canonicalSessionRows,
      mainKey: scenario.mainSessionKey,
    },
    isRecord,
  );
  if (hasCanonicalSessionsOverride) {
    // Persisted explicit snapshots bypass scenario-default enrichment so reload
    // preserves the same exact owner rows used by CAS, describe, and startup.
    sessions.replaceCanonicalList(canonicalSessionRows);
  }
  const terminalSessions = new Map<string, MockTerminalSession>();
  let terminalSessionSequence = 0;
  const sessionMessageSubscriptions = new Set<string>();
  const sockets: Array<{
    readonly readyState: number;
    readonly url: string;
    close: (code?: number, reason?: string) => void;
    openConnection: () => void;
  }> = [];
  let sessionMessageEventIndex = 0;
  let sessionMessageEventTimer: number | null = null;
  const offlineStateKey = "openclaw.control-ui-e2e.gatewayOffline";
  // Gateway-owned custom group catalog (sessions.groups.*). Persisted in
  // sessionStorage so a page reload keeps the catalog the way the real
  // gateway's SQLite store does; renames replay onto static sessions.list
  // fixtures because the real gateway rewrites member categories server-side.
  const groupsStateKey = "openclaw.control-ui-e2e.sessionGroups";
  let groupsState: {
    names: string[];
    defaults: Record<string, { cwd?: string; worktree?: boolean }>;
    sectionOrder: string[];
    renames: Array<{ from: string; to: string | null }>;
  } = {
    names: [...input.scenario.sessionGroups],
    defaults: { ...input.scenario.sessionGroupDefaults },
    sectionOrder: [],
    renames: [],
  };
  const responseFixtures = createResponses(
    {
      methodResponses: scenario.methodResponses,
      defaultAgentId: scenario.defaultAgentId,
      sessions,
      groupRenames: () => groupsState.renames,
    },
    isRecord,
  );
  let online = true;
  try {
    online = window.sessionStorage.getItem(offlineStateKey) !== "1";
  } catch {
    // Storage-disabled browser contexts still get the in-memory mock default.
  }
  try {
    const rawGroups = window.sessionStorage.getItem(groupsStateKey);
    if (rawGroups) {
      groupsState = JSON.parse(rawGroups) as typeof groupsState;
      groupsState.sectionOrder ??= [];
      groupsState.defaults ??= {};
    }
  } catch {
    // Storage-disabled browser contexts still get the scenario catalog.
  }
  let seq = 0;
  // Stateful config store: config.set/config.apply persist the submitted raw
  // and advance the hash so autosave -> reload flows round-trip edits the way
  // the real gateway does. Active only when the scenario ships a config.get
  // fixture with a raw string; persisted in sessionStorage like groupsState.
  const configStateKey = "openclaw.control-ui-e2e.configState";
  const baseConfigResponse: Record<string, unknown> | null = (() => {
    const configured = scenario.methodResponses["config.get"];
    return isRecord(configured) && typeof configured.raw === "string" ? configured : null;
  })();
  const initialConfigHash =
    typeof baseConfigResponse?.hash === "string" ? baseConfigResponse.hash : "mock-config-hash-0";
  const initialAppliedConfigHash =
    typeof baseConfigResponse?.appliedConfigHash === "string"
      ? baseConfigResponse.appliedConfigHash
      : initialConfigHash;
  let lastConfiguredConfigHash = initialConfigHash;
  let configState: {
    raw: string;
    revision: number;
    hash: string;
    appliedHash: string;
  } | null = baseConfigResponse
    ? {
        raw: baseConfigResponse.raw as string,
        revision: 0,
        hash: initialConfigHash,
        appliedHash: initialAppliedConfigHash,
      }
    : null;
  try {
    const rawConfigState = configState ? window.sessionStorage.getItem(configStateKey) : null;
    if (rawConfigState) {
      const stored = JSON.parse(rawConfigState) as unknown;
      if (
        isRecord(stored) &&
        typeof stored.raw === "string" &&
        typeof stored.revision === "number"
      ) {
        configState = {
          raw: stored.raw,
          revision: stored.revision,
          hash: typeof stored.hash === "string" ? stored.hash : initialConfigHash,
          appliedHash:
            typeof stored.appliedHash === "string" ? stored.appliedHash : initialAppliedConfigHash,
        };
      }
    }
  } catch {
    // Storage-disabled browser contexts still get the scenario fixture.
  }

  function persistConfigState(): void {
    try {
      window.sessionStorage.setItem(configStateKey, JSON.stringify(configState));
    } catch {
      // In-memory config still serves the current page.
    }
  }

  function persistGroupsState(): void {
    try {
      window.sessionStorage.setItem(groupsStateKey, JSON.stringify(groupsState));
    } catch {
      // In-memory catalog still serves the current page.
    }
  }

  function groupsPayload(): {
    groups: Array<{ name: string; position: number }>;
    sectionOrder: string[];
  } {
    return {
      groups: groupsState.names.map((name, position) => ({ name, position })),
      sectionOrder: [...groupsState.sectionOrder],
    };
  }

  function groupDefaultsPayload() {
    return {
      defaults: groupsState.names.map((name) => ({ name, ...groupsState.defaults[name] })),
    };
  }

  function normalizedGroupNames(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set<string>();
    const names: string[] = [];
    for (const raw of value) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  // This function is serialized with installControlUiMockGateway.toString().
  // Keep the guard local so the generated script captures no module imports.
  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.hasOwn(record, key);
  }

  function applyScenarioAgentModel(method: string, value: unknown): unknown {
    if (!scenario.agentModel || !isRecord(value)) {
      return value;
    }
    const applyAgentsList = (agentsList: unknown): unknown => {
      if (!isRecord(agentsList) || !Array.isArray(agentsList.agents)) {
        return agentsList;
      }
      return {
        ...agentsList,
        agents: agentsList.agents.map((agent) =>
          isRecord(agent) && !hasOwn(agent, "model")
            ? { ...agent, model: { primary: scenario.agentModel } }
            : agent,
        ),
      };
    };
    if (method === "agents.list") {
      return applyAgentsList(value);
    }
    return value;
  }

  type CommittedChatInput = {
    sessionId: string;
    runId: string;
    message: Record<string, unknown> & { __openclaw: { id: string; seq: number } };
  };
  const chatInputsStorageKey = "openclaw.control-ui-e2e.chatInputs";
  let committedChatInputs: CommittedChatInput[] = [];
  let historyMessagesOverridden = false;
  try {
    const stored = window.sessionStorage.getItem(chatInputsStorageKey);
    if (stored) {
      committedChatInputs = JSON.parse(stored) as CommittedChatInput[];
    }
  } catch {
    // The current page's mock still works without persistent browser storage.
  }

  function sourceIdempotencyKey(message: unknown): unknown {
    if (!isRecord(message) || message.role !== "user") {
      return undefined;
    }
    const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
    return metadata?.idempotencyKey ?? message.idempotencyKey;
  }

  function messageSequence(message: unknown): number {
    const metadata =
      isRecord(message) && isRecord(message["__openclaw"]) ? message["__openclaw"] : null;
    return typeof metadata?.seq === "number" && Number.isSafeInteger(metadata.seq)
      ? metadata.seq
      : 0;
  }

  function chatHistoryMessages(key: string): unknown[] {
    const row = sessions.read(key);
    const messages = [
      ...(scenario.sessionTranscripts[row.key]?.messages ?? scenario.historyMessages),
    ];
    if (historyMessagesOverridden && !scenario.sessionTranscripts[row.key]) {
      return messages;
    }
    for (const source of committedChatInputs.filter((entry) => entry.sessionId === row.sessionId)) {
      if (messages.some((message) => sourceIdempotencyKey(message) === `${source.runId}:user`)) {
        continue;
      }
      const next = messages.findIndex(
        (message) => messageSequence(message) > source.message["__openclaw"].seq,
      );
      messages.splice(next < 0 ? messages.length : next, 0, source.message);
    }
    return messages;
  }

  function commitDefaultChatInput(params: unknown): CommittedChatInput | undefined {
    if (
      !isRecord(params) ||
      typeof params.idempotencyKey !== "string" ||
      typeof params.message !== "string" ||
      (!params.intent && params.message.trimStart().startsWith("/"))
    ) {
      return undefined;
    }
    const row = sessions.read(
      typeof params.sessionKey === "string" ? params.sessionKey : scenario.sessionKey,
    );
    const existing = committedChatInputs.find(
      (entry) => entry.sessionId === row.sessionId && entry.runId === params.idempotencyKey,
    );
    if (existing) {
      return existing;
    }
    const sequence =
      Math.max(
        0,
        ...chatHistoryMessages(row.key).map(messageSequence),
        ...committedChatInputs
          .filter((source) => source.sessionId === row.sessionId)
          .map((source) => source.message["__openclaw"].seq),
      ) + 1;
    const media = createAttachmentFacts(params.attachments);
    const source: CommittedChatInput = {
      sessionId: String(row.sessionId),
      runId: params.idempotencyKey,
      message: {
        role: "user",
        content: params.message,
        timestamp: Date.now(),
        idempotencyKey: `${params.idempotencyKey}:user`,
        __openclaw: {
          id: `mock-user:${params.idempotencyKey}`,
          seq: sequence,
          ...(media.length ? { media } : {}),
          ...(Array.isArray(params.mentions) ? { humanMentions: params.mentions } : {}),
          ...(typeof params.replyToId === "string" ? { replyToId: params.replyToId } : {}),
        },
      },
    };
    committedChatInputs.push(source);
    if (media.length) {
      // Attachment turns ACK before their source receipt; publish actual source
      // consumption as a separate event after the response reaches the browser.
      window.queueMicrotask(() => {
        const currentSession = sessions.read(row.key);
        if (currentSession.sessionId !== source.sessionId) {
          return;
        }
        emitGatewayEvent(MockWebSocket.latest, "session.message", {
          sessionKey: row.key,
          sessionId: currentSession.sessionId,
          status: currentSession.status,
          hasActiveRun: currentSession.hasActiveRun,
          activeRunIds: currentSession.activeRunIds,
          session: currentSession,
          clientRunId: source.runId,
          messageId: source.message["__openclaw"].id,
          messageSeq: source.message["__openclaw"].seq,
          message: source.message,
        });
      });
    }
    try {
      window.sessionStorage.setItem(chatInputsStorageKey, JSON.stringify(committedChatInputs));
    } catch {
      // Committed fixture source remains available in the current page.
    }
    return source;
  }

  /** Transcript fields a scenario configured on chat.history, replayed onto the
   * chat.startup payload so both bootstrap paths serve the same conversation. */
  function configuredHistoryTranscript(): Record<string, unknown> {
    const configured = scenario.methodResponses["chat.history"];
    if (
      !isRecord(configured) ||
      responseFixtures.cases(configured) ||
      responseFixtures.sequence(configured)
    ) {
      return {};
    }
    const transcript: Record<string, unknown> = {};
    for (const field of [
      "messages",
      "activity",
      "sessionId",
      "sessionInfo",
      "inFlightRun",
      "thinkingLevel",
    ]) {
      if (hasOwn(configured, field)) {
        transcript[field] = configured[field];
      }
    }
    return transcript;
  }

  /** Presence slice of the connect snapshot. The self-flagged entry adopts the
   * connecting client's instanceId so presence surfaces resolve "you". */
  function presenceSnapshot(connectParams: unknown): { presence?: unknown[] } {
    if (scenario.presenceUsers.length === 0) {
      return {};
    }
    const client = isRecord(connectParams) ? connectParams.client : undefined;
    const selfInstanceId =
      isRecord(client) && typeof client.instanceId === "string"
        ? client.instanceId
        : "e2e-self-instance";
    return {
      presence: scenario.presenceUsers.map((user, index) => ({
        instanceId: user.self ? selfInstanceId : (user.instanceId ?? `e2e-presence-${index}`),
        mode: user.mode ?? "webchat",
        reason: "connect",
        ts: user.ts ?? Date.now(),
        ...(user.host ? { host: user.host } : {}),
        ...(user.ip ? { ip: user.ip } : {}),
        ...(user.platform ? { platform: user.platform } : {}),
        ...(user.deviceFamily ? { deviceFamily: user.deviceFamily } : {}),
        ...(user.lastInputSeconds === undefined ? {} : { lastInputSeconds: user.lastInputSeconds }),
        ...(user.onlineSince === undefined ? {} : { onlineSince: user.onlineSince }),
        ...(user.lastActivityAt === undefined ? {} : { lastActivityAt: user.lastActivityAt }),
        ...(user.timeZone ? { timeZone: user.timeZone } : {}),
        user: {
          id: user.id,
          ...(user.identity ? { identity: user.identity } : {}),
          name: user.name ?? null,
          email: user.email ?? null,
          avatarUrl: user.avatarUrl ?? null,
        },
        watchedSessions: user.watchedSessions ?? [],
      })),
    };
  }

  function recordSessionsPatchMany(params: unknown, response: unknown): unknown {
    if (!isRecord(params) || !Array.isArray(params.targets) || !isRecord(params.patch)) {
      return response;
    }
    const patch = params.patch;
    const outcomes =
      isRecord(response) && Array.isArray(response.outcomes) ? response.outcomes : null;
    return {
      ...(isRecord(response) ? response : {}),
      outcomes: params.targets.map((target, index) => {
        if (!isRecord(target) || typeof target.key !== "string") {
          return outcomes?.[index];
        }
        const outcome = outcomes?.[index];
        if (outcomes && (!isRecord(outcome) || outcome.ok !== true)) {
          return outcome;
        }
        const result = sessions.patch(target.key, patch);
        // Explicit outcomes remain wire injections; generated outcomes report the
        // same validation that decides whether the canonical row was committed.
        return (
          outcome ?? {
            key: target.key,
            ...(typeof target.agentId === "string" ? { agentId: target.agentId } : {}),
            ...("__mockError" in result
              ? { ok: false, error: result["__mockError"] }
              : { ok: true }),
          }
        );
      }),
    };
  }

  // Immediate and explicitly resolved deferred replies share one commit point.
  // Wire errors and rejected deferrals must leave canonical fixture state untouched.
  function commitFixtureResponse(method: string, params: unknown, response: unknown): unknown {
    if (isRecord(response) && (response["__mockError"] || response.ok === false)) {
      return response;
    }
    if (
      method === "sessions.search" &&
      isRecord(params) &&
      isRecord(params.scope) &&
      isRecord(response)
    ) {
      return responseFixtures.search(params, response);
    }
    if (
      method === "chat.send" &&
      isRecord(params) &&
      typeof params.sessionKey === "string" &&
      isRecord(response) &&
      response.status === "started" &&
      typeof response.runId === "string"
    ) {
      sessions.trackRun(params.sessionKey, response.runId, "running");
    }
    if (
      method === "chat.abort" &&
      isRecord(params) &&
      typeof params.sessionKey === "string" &&
      isRecord(response) &&
      response.aborted === true
    ) {
      return sessions.abortRuns(
        params.sessionKey,
        typeof params.runId === "string" ? params.runId : undefined,
        response,
      );
    }
    if (
      method === "sessions.catalog.startTerminal" &&
      isRecord(response) &&
      typeof response.sessionId === "string" &&
      typeof response.agentId === "string" &&
      typeof response.shell === "string" &&
      typeof response.cwd === "string" &&
      typeof response.confined === "boolean"
    ) {
      terminalSessions.set(response.sessionId, {
        sessionId: response.sessionId,
        agentId: response.agentId,
        shell: response.shell,
        cwd: response.cwd,
        confined: response.confined,
        attached: true,
        owner: "conn",
        createdAtMs: Date.now(),
        buffer: "",
        seq: 0,
      });
    }
    if (isRecord(params) && typeof params.id === "string") {
      const kind =
        method === "approval.resolve"
          ? params.kind === "system-agent"
            ? "openclaw"
            : params.kind
          : /^(exec|plugin)\.approval\.resolve$/u.exec(method)?.[1];
      if (typeof kind === "string") {
        pendingApprovals.get(`${kind}.approval.list`)?.delete(params.id);
      }
    }
    if (
      (method === "chat.history" || method === "chat.startup") &&
      isRecord(params) &&
      Array.isArray(params.inputRunIds) &&
      isRecord(response) &&
      !hasOwn(response, "inputReceipts")
    ) {
      const info = isRecord(response.sessionInfo) ? response.sessionInfo : undefined;
      const sessionId = info?.sessionId ?? response.sessionId;
      const inputRunIds = params.inputRunIds;
      return {
        ...response,
        inputReceipts: committedChatInputs
          .filter((source) => source.sessionId === sessionId && inputRunIds.includes(source.runId))
          .map((source) => ({
            runId: source.runId,
            state: "consumed",
            consumedByEventId: source.message["__openclaw"].id,
          })),
      };
    }
    if (method === "sessions.patch" && isRecord(params) && typeof params.key === "string") {
      if (
        typeof params.expectedSessionId === "string" &&
        sessions.read(params.key).sessionId !== params.expectedSessionId
      ) {
        return {
          __mockError: {
            code: "INVALID_REQUEST",
            message: "session identity changed; refresh and retry",
          },
        };
      }
      const result = sessions.patch(params.key, params);
      return "__mockError" in result || (isRecord(response) && Object.keys(response).length === 0)
        ? result
        : response;
    }
    if (method === "sessions.patchMany") {
      return recordSessionsPatchMany(params, response);
    }
    if (method === "sessions.create" || method === "sessions.catalog.continue") {
      recordMaterializedSession(params, response);
    }
    return response;
  }

  function emitGatewayEvent(
    socket: { deliver: (frame: unknown) => void } | null,
    event: string,
    payload: unknown,
  ): void {
    if (
      event === "chat" &&
      isRecord(payload) &&
      typeof payload.sessionKey === "string" &&
      typeof payload.runId === "string"
    ) {
      const status =
        payload.state === "final"
          ? "done"
          : payload.state === "error"
            ? "failed"
            : payload.state === "aborted"
              ? "killed"
              : undefined;
      if (status) {
        sessions.trackRun(
          payload.sessionKey,
          payload.runId,
          status,
          typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
        );
      }
    }
    const approval = /^(exec|plugin|openclaw)\.approval\.(requested|resolved)$/u.exec(event);
    if (approval && isRecord(payload) && typeof payload.id === "string") {
      // The Gateway registers pending state before publishing its event. A later
      // bootstrap/reconnect list must describe the same approval as the live stream.
      const method = `${approval[1]}.approval.list`;
      const queue = pendingApprovals.get(method) ?? new Map<string, Record<string, unknown>>();
      if (approval[2] === "requested") {
        queue.set(payload.id, payload);
      } else {
        queue.delete(payload.id);
      }
      pendingApprovals.set(method, queue);
    }
    socket?.deliver({ event, payload, seq: ++seq, type: "event" });
  }

  function recordMaterializedSession(params: unknown, response: unknown): void {
    if (!isRecord(response)) {
      return;
    }
    const key =
      typeof response.key === "string"
        ? response.key
        : typeof response.sessionKey === "string"
          ? response.sessionKey
          : "";
    if (!key.trim()) {
      return;
    }
    const label = isRecord(params) && typeof params.label === "string" ? params.label.trim() : "";
    sessions.materialize(key, {
      ...(isRecord(response.entry) ? response.entry : {}),
      ...(typeof response.sessionId === "string" ? { sessionId: response.sessionId } : {}),
      ...(label ? { displayName: label, label } : {}),
      hasActiveRun: response.runStarted === true,
      status: response.runStarted === true ? "running" : "done",
    });
  }

  function stopRepeatingSessionEvents(): void {
    if (sessionMessageEventTimer !== null) {
      window.clearInterval(sessionMessageEventTimer);
      sessionMessageEventTimer = null;
    }
  }

  function emitRepeatingSessionEvent(): void {
    const events = scenario.repeatingSessionEvents.events;
    if (events.length === 0) {
      return;
    }
    const event = events[sessionMessageEventIndex % events.length];
    sessionMessageEventIndex += 1;
    if (!event || !isRecord(event.payload) || typeof event.payload.sessionKey !== "string") {
      return;
    }
    if (!sessionMessageSubscriptions.has(event.payload.sessionKey)) {
      return;
    }
    MockWebSocket.latest?.deliver({
      event: event.event,
      payload: event.payload,
      seq: ++seq,
      type: "event",
    });
  }

  function startRepeatingSessionEvents(): void {
    if (sessionMessageEventTimer !== null || scenario.repeatingSessionEvents.events.length === 0) {
      return;
    }
    emitRepeatingSessionEvent();
    const intervalMs = Math.max(250, scenario.repeatingSessionEvents.intervalMs ?? 3_000);
    sessionMessageEventTimer = window.setInterval(emitRepeatingSessionEvent, intervalMs);
  }

  function updateSessionMessageSubscription(method: string, params: unknown): void {
    const sessionKey = isRecord(params) && typeof params.key === "string" ? params.key : "";
    if (!sessionKey) {
      return;
    }
    if (method === "sessions.messages.subscribe") {
      sessionMessageSubscriptions.add(sessionKey);
      startRepeatingSessionEvents();
      return;
    }
    if (method === "sessions.messages.unsubscribe") {
      sessionMessageSubscriptions.delete(sessionKey);
      if (sessionMessageSubscriptions.size === 0) {
        stopRepeatingSessionEvents();
      }
    }
  }

  function parseMockConfig(raw: string, fallback: unknown): { value: unknown; parsed: boolean } {
    try {
      return { value: parseJson5(raw), parsed: true };
    } catch {
      // Invalid raw keeps the caller's last valid fixture object.
      return { value: fallback, parsed: false };
    }
  }

  function adoptConfiguredConfig(configuredConfig: Record<string, unknown>): void {
    if (
      configState &&
      typeof configuredConfig.raw === "string" &&
      typeof configuredConfig.hash === "string" &&
      configuredConfig.hash !== lastConfiguredConfigHash
    ) {
      lastConfiguredConfigHash = configuredConfig.hash;
      Object.assign(configState, {
        raw: configuredConfig.raw,
        hash: configuredConfig.hash,
        appliedHash:
          typeof configuredConfig.appliedConfigHash === "string"
            ? configuredConfig.appliedConfigHash
            : configuredConfig.hash,
      });
      persistConfigState();
    }
  }

  function buildResponse(method: string, params: unknown): unknown {
    if (configState && baseConfigResponse) {
      if (method === "config.get") {
        const configured = responseFixtures.select(method, params);
        const configuredConfig = isRecord(configured.value) ? configured.value : baseConfigResponse;
        adoptConfiguredConfig(configuredConfig);
        const parsedConfig = parseMockConfig(configState.raw, configuredConfig.config);
        const parsedSource =
          parsedConfig.parsed &&
          typeof configuredConfig.raw === "string" &&
          configState.raw !== configuredConfig.raw &&
          isRecord(parsedConfig.value)
            ? parsedConfig.value
            : undefined;
        return {
          ...configuredConfig,
          ...(parsedSource && isRecord(configuredConfig.sourceConfig)
            ? { sourceConfig: parsedSource }
            : {}),
          ...(parsedSource && isRecord(configuredConfig.resolved)
            ? { resolved: parsedSource }
            : {}),
          config: parsedConfig.value,
          hash: configState.hash,
          configRevisionHash: configState.hash,
          appliedConfigHash: configState.appliedHash,
          raw: configState.raw,
        };
      }
      if (method === "config.set" || method === "config.apply") {
        // Enforce the production CAS contract: stale base hashes are rejected
        // (same code/message as the gateway) so conflict recovery is testable.
        const baseHash = isRecord(params) ? params.baseHash : undefined;
        if (baseHash !== configState.hash) {
          return {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "config changed since last load; re-run config.get and retry",
            },
          };
        }
        const raw = isRecord(params) && typeof params.raw === "string" ? params.raw : null;
        if (raw !== null) {
          const revision = configState.revision + 1;
          const hash = `mock-config-hash-${revision}`;
          configState = {
            raw,
            revision,
            hash,
            appliedHash:
              method === "config.apply"
                ? hash
                : (configState.appliedHash ?? initialAppliedConfigHash),
          };
          persistConfigState();
        }
        const configured = responseFixtures.select(method, params);
        const configuredAck = isRecord(configured.value) ? configured.value : {};
        // Like the real gateway, return the persisted config and its new hash.
        return {
          ...configuredAck,
          ok: true,
          path: baseConfigResponse.path,
          hash: configState.hash,
          config: parseMockConfig(configState.raw, baseConfigResponse.config).value,
        };
      }
    }
    const configured = responseFixtures.select(method, params);
    if (configured.found) {
      const configuredValue = applyScenarioAgentModel(method, configured.value);
      return method === "sessions.list"
        ? sessions.listResponse(configuredValue, params, {
            renames: groupsState.renames,
            archiveFiltering: scenario.sessionArchiveFiltering,
          })
        : configuredValue;
    }
    switch (method) {
      case "exec.approval.list":
      case "plugin.approval.list":
      case "openclaw.approval.list":
        return [...(pendingApprovals.get(method)?.values() ?? [])].filter(
          (approval) =>
            typeof approval.expiresAtMs === "number" && approval.expiresAtMs > Date.now(),
        );
      case "connect": {
        const auth = isRecord(params) && isRecord(params.auth) ? params.auth : null;
        const connectedDeviceToken =
          auth && typeof auth.deviceToken === "string" ? auth.deviceToken : scenario.deviceToken;
        return {
          ...(scenario.omitConnectHelloAuth
            ? {}
            : {
                auth: {
                  deviceToken: connectedDeviceToken,
                  method: scenario.authMethod,
                  recoveryMigrationAllowed: true as const,
                  recoveryScope: "e2e-recovery-scope",
                  role: "operator",
                  scopes: scenario.operatorScopes,
                },
              }),
          features: {
            capabilities: scenario.featureCapabilities,
            events: [],
            ...(scenario.omitFeatureMethods ? {} : { methods: scenario.featureMethods }),
          },
          controlUiTabs: scenario.controlUiTabs,
          controlUiLinkReaders: scenario.controlUiLinkReaders ?? [],
          controlUiWidgetKinds: scenario.controlUiWidgetKinds,
          protocol: protocolVersion,
          server: {
            buildId: serverBuildId,
            bootId: gatewayBootId,
            controlUiBuildSource: scenario.controlUiBuildSource,
            connId: "control-ui-e2e",
            version: scenario.serverVersion,
          },
          policy: {
            maxPayload: scenario.maxPayload,
            maxBufferedBytes: 1_048_576,
            tickIntervalMs: 30_000,
            attachments: {
              maxBytes: scenario.attachmentMaxBytes,
              maxImageBytes: Math.min(scenario.attachmentMaxBytes, 5 * 1024 * 1024),
            },
            allowedSessionVisibilities: scenario.allowedSessionVisibilities,
            hasMultipleSessionSharingIdentities: scenario.hasMultipleSessionSharingIdentities,
          },
          snapshot: {
            ...(scenario.authMode ? { authMode: scenario.authMode } : {}),
            suspension: { phase: scenario.gatewaySuspensionPhase },
            ...presenceSnapshot(params),
            ...(scenario.updateAvailable ? { updateAvailable: scenario.updateAvailable } : {}),
            ...(scenario.updateSchedule ? { updateSchedule: scenario.updateSchedule } : {}),
            sessionDefaults: {
              defaultAgentId: scenario.defaultAgentId,
              mainKey: "main",
              mainSessionKey: scenario.mainSessionKey,
              modelConfigured: Boolean(scenario.agentModel),
              scope: scenario.sessionScope,
            },
          },
          type: "hello-ok",
        };
      }
      case "sessions.github.options":
        return {
          personal: scenario.presenceUsers.some((user) => user.self)
            ? {
                state: "disconnected",
                generation: null,
                account: null,
                accessExpiresAtMs: null,
                refreshState: "not_applicable",
                pending: null,
              }
            : null,
          shared: { source: "system-configured", accountId: 1, login: "system-bot" },
          pendingPersonal: null,
        };
      case "users.listAuthLinks":
        return { links: [] };
      case "users.listModelAccounts":
        return {
          profileId:
            isRecord(params) && typeof params.profileId === "string"
              ? params.profileId
              : (scenario.presenceUsers.find((user) => user.self)?.id ?? "profile-1"),
          accounts: [],
          links: [],
        };
      case "users.list":
        return { profiles: [] };
      case "users.github.status":
      case "tools.github.status": {
        const system = {
          source: "system-detected",
          credentialKind: "native",
          credentialState: "unavailable",
          account: null,
          gitAuthor: { name: null, email: null },
          evidence: "none",
          accessExpiresAtMs: null,
          refreshState: "not_applicable",
          oauthScopes: [],
          repositoryGrants: "unknown",
        };
        if (method === "users.github.status") {
          return scenario.presenceUsers.some((user) => user.self)
            ? {
                personal: {
                  state: "disconnected",
                  generation: null,
                  account: null,
                  accessExpiresAtMs: null,
                  refreshState: "not_applicable",
                  pending: null,
                },
                system,
              }
            : {
                __mockError: {
                  code: "FORBIDDEN",
                  message:
                    "My GitHub requires a verified durable user profile; sign in and try again.",
                },
              };
        }
        const selectedScope =
          isRecord(params) && params.selectedScope === "agent" ? "agent" : "system";
        return {
          agentId: isRecord(params) ? params.agentId : scenario.defaultAgentId,
          selectedScope,
          selected: {
            scope: selectedScope,
            configured: false,
            identity: selectedScope === "system" ? system : null,
          },
          effective: system,
        };
      }
      case "users.github.authorize.cancel":
      case "tools.github.authorize.cancel":
        return { cancelled: true };
      case "users.github.disconnect":
        return { disconnected: true };
      case "agent.identity.get":
        return {
          agentId: scenario.assistantAgentId,
          avatar: "",
          avatarStatus: "none",
          name: scenario.assistantName,
        };
      case "agents.list":
        return {
          agents: [
            {
              id: scenario.defaultAgentId,
              identity: { name: scenario.assistantName },
              ...(scenario.agentModel ? { model: { primary: scenario.agentModel } } : {}),
              name: scenario.assistantName,
              ...(scenario.workspace ? { workspace: scenario.workspace } : {}),
              workspaceGit: scenario.workspaceGit,
            },
          ],
          defaultId: scenario.defaultAgentId,
          mainKey: "main",
          scope: scenario.sessionScope,
        };
      case "agents.files.list":
        return {
          agentId:
            isRecord(params) && typeof params.agentId === "string"
              ? params.agentId
              : scenario.defaultAgentId,
          files: [],
          workspace: "",
        };
      case "agents.files.get":
        return null;
      case "sessions.files.list":
        return {
          browser: {
            entries: [],
            path: "",
          },
          files: [],
          root: "",
          sessionKey:
            isRecord(params) && typeof params.sessionKey === "string" ? params.sessionKey : "main",
        };
      case "sessions.files.get":
        return null;
      case "artifacts.list":
        return { artifacts: [] };
      case "artifacts.download":
        return null;
      case "sessions.resolve":
        return sessions.resolve(isRecord(params) ? params : {});
      case "chat.history":
      case "chat.startup": {
        const resolution =
          method === "chat.startup" && isRecord(params) && typeof params.shortId === "string"
            ? sessions.resolve(params)
            : undefined;
        if (resolution && !resolution.ok) {
          return { resolution, messages: [] };
        }
        const key = resolution?.ok
          ? resolution.key
          : isRecord(params) && typeof params.sessionKey === "string"
            ? params.sessionKey
            : scenario.sessionKey;
        const row = sessions.read(key);
        const info = sessions.sessionInfo(key);
        const override =
          !hasCanonicalSessionsOverride && row.key === sessions.read(scenario.sessionKey).key
            ? scenario.sessionInfo
            : null;
        const transcript = {
          ...(scenario.inFlightRun ? { inFlightRun: scenario.inFlightRun } : {}),
          ...scenario.sessionTranscripts[row.key],
        };
        const transcriptRun = transcript.inFlightRun;
        const inFlightRun =
          transcriptRun &&
          Array.isArray(row.activeRunIds) &&
          !row.activeRunIds.includes(transcriptRun.runId)
            ? null
            : transcriptRun;
        return {
          ...(resolution ? { resolution } : {}),
          sessionId: row.sessionId,
          ...(info || override ? { sessionInfo: { ...info, ...override } } : {}),
          thinkingLevel: null,
          ...transcript,
          ...(transcriptRun ? { inFlightRun } : {}),
          messages: chatHistoryMessages(row.key),
          ...(method === "chat.startup"
            ? {
                metadata: { models: scenario.models },
                // Static transcript overrides intentionally replay on startup too.
                ...configuredHistoryTranscript(),
              }
            : {}),
        };
      }
      case "sessions.describe": {
        const key =
          isRecord(params) && typeof params.key === "string" ? params.key : scenario.sessionKey;
        return { session: sessions.sessionInfo(key) ?? null };
      }
      case "chat.metadata":
        return {
          commands: [],
          models: scenario.models,
        };
      case "talk.catalog":
        return {
          modes: [],
          transports: [],
          brains: [],
          speech: { providers: [] },
          transcription: { providers: [] },
          realtime: { ready: true, providers: [] },
        };
      case "chat.send": {
        // The default fixture starts execution. Its original source is canonical
        // before ACK; explicit responses and held requests model other outcomes.
        const source = commitDefaultChatInput(params);
        return {
          runId:
            isRecord(params) && typeof params.idempotencyKey === "string"
              ? params.idempotencyKey
              : "control-ui-e2e-run",
          status: "started",
          ...(source &&
          (!isRecord(params) ||
            !Array.isArray(params.attachments) ||
            params.attachments.length === 0)
            ? {
                messageId: source.message["__openclaw"].id,
                messageSeq: source.message["__openclaw"].seq,
              }
            : {}),
        };
      }
      case "chat.abort":
        return { aborted: true };
      case "skills.proposals.list":
        return {
          schema: "openclaw.skill-workshop.proposals-manifest.v1",
          updatedAt: new Date().toISOString(),
          proposals: [],
          installedSkills: [],
        };
      case "skills.status":
        return {
          workspaceDir: "/tmp/control-ui-mock/workspace",
          managedSkillsDir: "/tmp/control-ui-mock/skills",
          skills: [],
        };
      case "skills.library.list":
        return {
          entries: [],
          profileId: null,
          multipleProfiles: false,
          defaultTarget: "workspace",
          canManageWorkspace: true,
          defaultSelectionLimit: 64,
          ...(isRecord(params) && typeof params.sessionKey === "string"
            ? { session: { sessionKey: params.sessionKey, selections: [], attachable: [] } }
            : {}),
        };
      case "commands.list":
        return { commands: [] };
      case "plugins.list":
        return { plugins: [] };
      case "health":
        return {
          agents: [],
          defaultAgentId: scenario.defaultAgentId,
          durationMs: 0,
          heartbeatSeconds: 0,
          ok: true,
          sessions: { count: 1, path: "", recent: [] },
          ts: Date.now(),
        };
      case "models.authStatus":
        return { ts: Date.now(), providers: [] };
      case "models.list":
        return { models: scenario.models };
      case "sessions.create": {
        const agentId =
          isRecord(params) && typeof params.agentId === "string"
            ? params.agentId
            : scenario.defaultAgentId;
        const requestedKey =
          isRecord(params) && typeof params.key === "string" ? params.key.trim() : "";
        const response = {
          key: requestedKey || `agent:${agentId}:mock-created-${sessions.materializedCount() + 1}`,
        };
        return response;
      }
      case "sessions.list":
        return sessions.listResponse(responseFixtures.sessionList(), params, {
          renames: groupsState.renames,
          archiveFiltering: scenario.sessionArchiveFiltering,
        });
      case "sessions.search":
        return { results: [] };
      case "sessions.patchMany":
        return {};
      case "sessions.groups.list":
        return groupsPayload();
      case "sessions.groups.defaults":
        return groupDefaultsPayload();
      case "sessions.groups.put": {
        groupsState.names = normalizedGroupNames(isRecord(params) ? params.names : undefined);
        if (isRecord(params) && Array.isArray(params.sectionOrder)) {
          groupsState.sectionOrder = normalizedGroupNames(params.sectionOrder);
        }
        persistGroupsState();
        return { ok: true, ...groupsPayload() };
      }
      case "sessions.groups.rename": {
        const from = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        const to = isRecord(params) && typeof params.to === "string" ? params.to.trim() : "";
        if (from && to && from !== to) {
          const sourceIndex = groupsState.names.indexOf(from);
          const names = groupsState.names.filter((name) => name !== from);
          if (!names.includes(to)) {
            // Renames keep the source position, like the real catalog.
            names.splice(sourceIndex < 0 ? names.length : sourceIndex, 0, to);
          }
          groupsState.names = names;
          if (!groupsState.defaults[to] && groupsState.defaults[from]) {
            groupsState.defaults[to] = groupsState.defaults[from];
          }
          delete groupsState.defaults[from];
          const sourceSectionId = `category:${from}`;
          const targetSectionId = `category:${to}`;
          groupsState.sectionOrder = groupsState.sectionOrder.flatMap((sectionId) => {
            if (sectionId !== sourceSectionId) {
              return [sectionId];
            }
            return groupsState.sectionOrder.includes(targetSectionId) ? [] : [targetSectionId];
          });
          groupsState.renames.push({ from, to });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.groups.update": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          const cwd = isRecord(params) && typeof params.cwd === "string" ? params.cwd.trim() : "";
          groupsState.defaults[name] = {
            ...(cwd ? { cwd } : {}),
            worktree: isRecord(params) && params.worktree === true,
          };
          persistGroupsState();
        }
        return { ok: true, ...groupDefaultsPayload() };
      }
      case "sessions.groups.delete": {
        const name = isRecord(params) && typeof params.name === "string" ? params.name.trim() : "";
        if (name) {
          groupsState.names = groupsState.names.filter((existing) => existing !== name);
          delete groupsState.defaults[name];
          groupsState.sectionOrder = groupsState.sectionOrder.filter(
            (sectionId) => sectionId !== `category:${name}`,
          );
          groupsState.renames.push({ from: name, to: null });
          persistGroupsState();
        }
        return { ok: true, updatedSessions: 0, ...groupsPayload() };
      }
      case "sessions.subscribe":
        return { subscribed: true };
      case "sessions.messages.subscribe":
        return {
          key: isRecord(params) && typeof params.key === "string" ? params.key : "",
        };
      case "sessions.messages.unsubscribe":
        return { ok: true };
      case "terminal.open": {
        const sessionId = `control-ui-mock-terminal-${++terminalSessionSequence}`;
        const session: MockTerminalSession = {
          sessionId,
          agentId:
            isRecord(params) && typeof params.agentId === "string"
              ? params.agentId
              : scenario.defaultAgentId,
          shell: "/bin/zsh",
          cwd: scenario.workspace || "/workspace/openclaw",
          confined: false,
          attached: true,
          owner: "conn",
          createdAtMs: Date.now(),
          buffer: "",
          seq: 0,
        };
        terminalSessions.set(sessionId, session);
        return {
          sessionId: session.sessionId,
          agentId: session.agentId,
          shell: session.shell,
          cwd: session.cwd,
          confined: session.confined,
        };
      }
      case "terminal.attach": {
        const sessionId = isRecord(params) ? params.sessionId : undefined;
        const session = typeof sessionId === "string" ? terminalSessions.get(sessionId) : null;
        return session
          ? {
              sessionId: session.sessionId,
              agentId: session.agentId,
              shell: session.shell,
              cwd: session.cwd,
              confined: session.confined,
              buffer: session.buffer,
              seq: session.seq,
            }
          : {};
      }
      case "terminal.list":
        return {
          sessions: [...terminalSessions.values()].map(
            ({ buffer: _buffer, seq: _seq, ...session }) => session,
          ),
        };
      case "terminal.input":
      case "terminal.resize":
        return { ok: true };
      case "terminal.close": {
        const sessionId = isRecord(params) ? params.sessionId : undefined;
        if (typeof sessionId === "string") {
          terminalSessions.delete(sessionId);
        }
        return { ok: true };
      }
      default:
        return {};
    }
  }

  function emitTerminalOutput(
    socket: { deliver: (frame: unknown) => void },
    method: string,
    params: unknown,
    response: unknown,
  ): void {
    let data = "";
    let session: MockTerminalSession | undefined;
    if (
      (method === "terminal.open" || method === "sessions.catalog.startTerminal") &&
      isRecord(response) &&
      typeof response.sessionId === "string"
    ) {
      session = terminalSessions.get(response.sessionId);
      data = "OpenClaw mock terminal\r\nType anything and the mock Gateway will echo it.\r\n$ ";
    } else if (method === "terminal.input" && isRecord(params)) {
      session =
        typeof params.sessionId === "string" ? terminalSessions.get(params.sessionId) : undefined;
      data = typeof params.data === "string" ? params.data : "";
    }
    if (!session || !data) {
      return;
    }
    session.buffer += data;
    session.seq += data.length;
    socket.deliver({
      event: "terminal.data",
      payload: { sessionId: session.sessionId, seq: session.seq, data },
      seq: ++seq,
      type: "event",
    });
  }

  function shouldDefer(method: string, params: unknown): boolean {
    if (heldMethods.has(method)) {
      return true;
    }
    const index = deferredMethods.findIndex(
      (candidate) =>
        candidate.method === method && responseFixtures.matches(params, candidate.match),
    );
    if (index < 0) {
      return false;
    }
    deferredMethods.splice(index, 1);
    return true;
  }

  function takeDeferredResponses(method: string): DeferredResponse[] {
    const index = deferredResponses.findIndex((response) => response.method === method);
    if (index < 0) {
      throw new Error(`No deferred mock Gateway response for ${method}`);
    }
    if (!heldMethods.delete(method)) {
      return deferredResponses.splice(index, 1);
    }
    // Startup can replace a request when connection scope settles. A held
    // catalog releases every admitted request, not only its retired predecessor.
    const responses = deferredResponses.filter((response) => response.method === method);
    for (let i = deferredResponses.length - 1; i >= 0; i -= 1) {
      if (deferredResponses[i]?.method === method) {
        deferredResponses.splice(i, 1);
      }
    }
    return responses;
  }

  function parseFrame(raw: string | ArrayBufferLike | Blob | ArrayBufferView): BrowserFrame | null {
    if (typeof raw !== "string") {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as BrowserFrame;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  class MockWebSocket extends EventTarget {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static latest: MockWebSocket | null = null;

    binaryType: BinaryType = "blob";
    readonly bufferedAmount = 0;
    readonly extensions = "";
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    readonly protocol = "";
    readyState = MockWebSocket.CONNECTING;
    readonly url: string;
    private tickTimer: number | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      MockWebSocket.latest = this;
      sockets.push(this);
      window.setTimeout(() => {
        this.openConnection();
      }, 0);
    }

    openConnection(): void {
      if (!online || this.readyState !== MockWebSocket.CONNECTING) {
        return;
      }
      this.readyState = MockWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.deliver({
        event: "connect.challenge",
        payload: {
          nonce: "control-ui-e2e-nonce",
          ts: Date.now(),
          capabilities: scenario.connectCapabilities,
        },
        type: "event",
      });
    }

    override dispatchEvent(event: Event): boolean {
      const dispatched = super.dispatchEvent(event);
      if (event.type === "open") {
        this.onopen?.(event);
      } else if (event.type === "message") {
        this.onmessage?.(event as MessageEvent);
      } else if (event.type === "close") {
        this.onclose?.(event as CloseEvent);
      } else if (event.type === "error") {
        this.onerror?.(event);
      }
      return dispatched;
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === MockWebSocket.CLOSED) {
        return;
      }
      this.readyState = MockWebSocket.CLOSED;
      if (this.tickTimer !== null) {
        window.clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      sessionMessageSubscriptions.clear();
      stopRepeatingSessionEvents();
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    }

    send(raw: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const frame = parseFrame(raw);
      if (!frame || frame.type !== "req") {
        return;
      }
      const id = typeof frame.id === "string" ? frame.id : "";
      const method = typeof frame.method === "string" ? frame.method : "";
      if (!id || !method) {
        return;
      }
      requests.push({ id, method, params: frame.params });
      if (shouldDefer(method, frame.params)) {
        deferredResponses.push({ id, method, params: frame.params, socket: this });
        return;
      }
      const respond = (response: unknown) => {
        const payload = commitFixtureResponse(method, frame.params, response);
        const mockError =
          isRecord(payload) && isRecord(payload["__mockError"]) ? payload["__mockError"] : null;
        this.deliver(
          mockError
            ? { id, ok: false, error: mockError, type: "res" }
            : { id, ok: true, payload, type: "res" },
        );
        if (!mockError) {
          emitTerminalOutput(this, method, frame.params, payload);
        }
        if (!mockError && method === "connect" && this.readyState === MockWebSocket.OPEN) {
          this.tickTimer = window.setInterval(() => {
            this.deliver({ event: "tick", payload: {}, seq: ++seq, type: "event" });
          }, 30_000);
        }
        if (!mockError) {
          updateSessionMessageSubscription(method, frame.params);
        }
        if (
          !mockError &&
          method === "chat.abort" &&
          isRecord(frame.params) &&
          typeof frame.params.sessionKey === "string" &&
          isRecord(payload) &&
          payload.aborted === true
        ) {
          const sessionKey = frame.params.sessionKey;
          const runIds = Array.isArray(payload.runIds) ? payload.runIds : [];
          for (const runId of runIds) {
            emitGatewayEvent(this, "chat", { runId, sessionKey, state: "aborted" });
          }
          const session = sessions.sessionInfo(sessionKey);
          emitGatewayEvent(this, "sessions.changed", {
            ...session,
            sessionKey,
            reason: "lifecycle",
            ts: Date.now(),
            session,
          });
        }
      };
      window.setTimeout(() => {
        const handler = requestHandlers.get(method);
        if (handler) {
          // Delayed fixtures retain this request and socket, even when another
          // request for the same method finishes first.
          handler({
            params: frame.params,
            respond,
            emit: (event, payload) => emitGatewayEvent(this, event, payload),
          });
        } else {
          respond(buildResponse(method, frame.params));
        }
      }, 0);
    }

    suspend(): void {
      if (this.tickTimer !== null) {
        window.clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }

    deliver(frame: unknown): void {
      if (this.readyState !== MockWebSocket.OPEN) {
        return;
      }
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  }

  const exposed: ControlUiMockGateway = {
    closeLatest(code, reason) {
      MockWebSocket.latest?.close(code ?? 1006, reason ?? "mock close");
    },
    deliverLatest(frame) {
      MockWebSocket.latest?.deliver(frame);
    },
    deferNext(method, match) {
      deferredMethods.push({ method, match });
    },
    emit(event, payload) {
      emitGatewayEvent(MockWebSocket.latest, event, payload);
    },
    findRequests(method, match) {
      // Capture and deferral must select the same RPC scope; child lists share the roster method.
      return requests.filter(
        (request) =>
          (!method || request.method === method) && responseFixtures.matches(request.params, match),
      );
    },
    rejectDeferred(method, error) {
      for (const response of takeDeferredResponses(method)) {
        response.socket.deliver({
          error: {
            code: error?.code ?? "INVALID_REQUEST",
            message: error?.message ?? "mock Gateway rejected request",
            ...(error?.details ? { details: error.details } : {}),
            ...(error?.retryable ? { retryable: true } : {}),
          },
          id: response.id,
          ok: false,
          type: "res",
        });
      }
    },
    requests,
    resolveDeferred(method, payload) {
      for (const response of takeDeferredResponses(method)) {
        const resolvedPayload = commitFixtureResponse(
          response.method,
          response.params,
          applyScenarioAgentModel(
            response.method,
            payload ?? buildResponse(response.method, response.params),
          ),
        );
        const mockError = isRecord(resolvedPayload) ? resolvedPayload["__mockError"] : undefined;
        response.socket.deliver({
          id: response.id,
          ok: !mockError,
          ...(mockError ? { error: mockError } : { payload: resolvedPayload }),
          type: "res",
        });
        if (!mockError) {
          emitTerminalOutput(response.socket, response.method, response.params, resolvedPayload);
        }
      }
    },
    suspendLatest() {
      MockWebSocket.latest?.suspend();
    },
    setOnline(nextOnline) {
      online = nextOnline;
      try {
        if (online) {
          window.sessionStorage.removeItem(offlineStateKey);
        } else {
          window.sessionStorage.setItem(offlineStateKey, "1");
        }
      } catch {
        // The current document can still toggle the in-memory mock.
      }
      if (!online) {
        // Close handlers can synchronously construct replacements. Snapshot the
        // transition members so an offline replacement stays ready for recovery.
        const transitionSockets = sockets.slice();
        for (const socket of transitionSockets) {
          socket.close(1006, "mock offline");
        }
        return;
      }
      const transitionSockets = sockets.slice();
      for (const socket of transitionSockets) {
        socket.openConnection();
      }
    },
    setGatewayBootId(nextBootId) {
      gatewayBootId = nextBootId;
    },
    setServerBuildId(nextBuildId) {
      serverBuildId = nextBuildId;
      try {
        window.sessionStorage.setItem(serverBuildIdStateKey, nextBuildId);
      } catch {
        // The current document still observes the new identity.
      }
    },
    setOperatorScopes(scopes) {
      scenario.operatorScopes = [...scopes];
    },
    getSessionRow(key) {
      const row = sessions.sessionInfo(key);
      if (!row) {
        throw new Error(`Mock Gateway did not return session ${key}`);
      }
      return row;
    },
    setRequestHandler(method, handler) {
      requestHandlers.set(method, handler);
    },
    setMethodResponse(method, payload) {
      scenario.methodResponses[method] = payload;
      responseFixtures.resetSequence(method);
      methodResponseOverrides[method] = payload;
      if (method === "config.get" && isRecord(payload)) {
        adoptConfiguredConfig(payload);
      }
      try {
        window.sessionStorage.setItem(
          methodResponseOverridesStorageKey,
          JSON.stringify(methodResponseOverrides),
        );
      } catch {
        // Current-document responses still work if browser storage is unavailable.
      }
    },
    setSessionsListResponse(payload) {
      // Generic method responses may be stale or delayed. Only this explicit
      // owner transition advances the canonical rows used by mutation CAS.
      sessions.replaceCanonicalList(payload.sessions);
      hasCanonicalSessionsOverride = true;
      try {
        window.sessionStorage.setItem(
          canonicalSessionsStorageKey,
          JSON.stringify(payload.sessions),
        );
      } catch {
        // The current document still observes the canonical replacement.
      }
      this.setMethodResponse("sessions.list", responseFixtures.sessionList(payload));
    },
    setSessionSharingPolicy(policy) {
      scenario.allowedSessionVisibilities = policy.allowedSessionVisibilities;
      scenario.hasMultipleSessionSharingIdentities = policy.hasMultipleSessionSharingIdentities;
    },
    setHistoryMessages(messages) {
      historyMessagesOverridden = true;
      scenario.historyMessages = Array.isArray(messages) ? messages : [];
      const configuredHistory = scenario.methodResponses["chat.history"];
      if (isRecord(configuredHistory) && !responseFixtures.cases(configuredHistory)) {
        configuredHistory.messages = scenario.historyMessages;
      }
    },
    socketCount() {
      return sockets.length;
    },
    socketStates() {
      return sockets.map((socket) => ({
        readyState: socket.readyState,
        state:
          socket.readyState === MockWebSocket.CONNECTING
            ? "connecting"
            : socket.readyState === MockWebSocket.OPEN
              ? "open"
              : socket.readyState === MockWebSocket.CLOSING
                ? "closing"
                : "closed",
        url: socket.url,
      }));
    },
    socketUrls() {
      return sockets.map((socket) => socket.url);
    },
  };

  (window as MockGatewayWindow).openclawControlUiE2eGateway = exposed;
  const RoutedWebSocket = function (url: string | URL, protocols?: string | string[]) {
    const resolvedUrl = String(url);
    // Vite's dev client must keep its real socket: the mock would fake the
    // open handshake, and a later setOnline(false) close would make the client
    // believe the dev server restarted and reload the page mid-test.
    const isViteHmr = Array.isArray(protocols)
      ? protocols.includes("vite-hmr")
      : protocols === "vite-hmr";
    if (
      isViteHmr ||
      scenario.webSocketPassthroughPrefixes.some((prefix) => resolvedUrl.startsWith(prefix))
    ) {
      return protocols === undefined
        ? new NativeWebSocket(resolvedUrl)
        : new NativeWebSocket(resolvedUrl, protocols);
    }
    return new MockWebSocket(resolvedUrl);
  };
  RoutedWebSocket.prototype = MockWebSocket.prototype;
  Object.assign(RoutedWebSocket, {
    CLOSED: MockWebSocket.CLOSED,
    CLOSING: MockWebSocket.CLOSING,
    CONNECTING: MockWebSocket.CONNECTING,
    OPEN: MockWebSocket.OPEN,
  });
  window.WebSocket = RoutedWebSocket as unknown as typeof WebSocket;
  window.addEventListener("pagehide", () => {
    sessionMessageSubscriptions.clear();
    stopRepeatingSessionEvents();
  });
}

export async function prepareControlUiMockGatewayScenario(
  scenario: ControlUiMockGatewayScenario = {},
) {
  const { prepareNativeControlUiPluginFixtures } = await import("./control-ui-plugin-fixture.ts");
  const { catalog, assets } = await prepareNativeControlUiPluginFixtures(
    scenario.nativePlugins ?? [],
  );
  const preparedScenario = catalog.plugins.length
    ? {
        ...scenario,
        featureMethods: [
          ...new Set([
            ...(scenario.featureMethods ?? defaultControlUiFeatureMethods),
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ]),
        ],
        methodResponses: {
          ...scenario.methodResponses,
          "plugins.controlUi.list": catalog,
          "plugins.controlUi.report": { ok: true },
        },
      }
    : scenario;
  return { scenario: preparedScenario, assets };
}

export async function installMockGateway(
  page: Page,
  scenario: ControlUiMockGatewayScenario = {},
): Promise<MockGatewayControls> {
  const prepared = await prepareControlUiMockGatewayScenario(scenario);
  if (prepared.assets.size) {
    await page.route(`**${controlUiPluginAssetRoot()}**`, async (route) => {
      const asset = prepared.assets.get(new URL(route.request().url()).pathname);
      await route.fulfill(asset ? { status: 200, ...asset } : { status: 404 });
    });
  }
  const normalizedScenario = normalizeScenario(prepared.scenario);
  const diagnosticEvents = installControlUiE2ePageDiagnosticRing(page);
  await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
    route.fulfill({
      body: JSON.stringify(createControlUiMockBootstrapConfig(normalizedScenario)),
      contentType: "application/json",
      status: 200,
    }),
  );
  await installControlUiE2eUnhandledRejectionRing(page);
  await page.addInitScript({ content: createControlUiMockGatewayInitScript(normalizedScenario) });
  return createMockGatewayControls(
    page,
    normalizedScenario.sessionKey,
    diagnosticEvents,
    normalizedScenario.methodResponses,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outDir] = process.argv.slice(2);
  if (command !== "--production-build" || !outDir) {
    throw new Error("Usage: control-ui-e2e.ts --production-build <out-dir>");
  }
  await runProductionControlUiBuild(outDir);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
