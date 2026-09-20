import { writeFileSync } from "node:fs";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConsoleMessage, Frame, Page, Request } from "playwright";
import { agentRouteFromPath, isRouteId, pathForRoute } from "../app-route-paths.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";

const CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT = 200;
const controlUiE2ePageDiagnostics = new WeakMap<Page, ControlUiE2eDiagnosticEvent[]>();
const controlUiE2eUnhandledRejectionPages = new WeakSet<Page>();

export type ControlUiE2eDiagnosticEvent = {
  at: string;
  details: Record<string, unknown>;
  source: "console" | "framenavigated" | "pageerror" | "requestfailed";
};

export function installControlUiE2ePageDiagnosticRing(page: Page): ControlUiE2eDiagnosticEvent[] {
  const existing = controlUiE2ePageDiagnostics.get(page);
  if (existing) {
    return existing;
  }
  const events: ControlUiE2eDiagnosticEvent[] = [];
  const push = (event: ControlUiE2eDiagnosticEvent) => {
    events.push(event);
    if (events.length > CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT) {
      events.splice(0, events.length - CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT);
    }
  };
  const onConsole = (message: ConsoleMessage) => {
    push({
      at: new Date().toISOString(),
      details: {
        location: message.location(),
        text: message.text(),
        type: message.type(),
      },
      source: "console",
    });
  };
  const onPageError = (error: Error) => {
    push({
      at: new Date().toISOString(),
      details: { message: error.message, name: error.name, stack: error.stack ?? null },
      source: "pageerror",
    });
  };
  const onRequestFailed = (request: Request) => {
    push({
      at: new Date().toISOString(),
      details: {
        errorText: request.failure()?.errorText ?? null,
        method: request.method(),
        resourceType: request.resourceType(),
        url: request.url(),
      },
      source: "requestfailed",
    });
  };
  const onFrameNavigated = (frame: Frame) => {
    // Main-frame navigations order boot/reload sequences in failure reports;
    // subframes are noise.
    if (frame !== page.mainFrame()) {
      return;
    }
    push({
      at: new Date().toISOString(),
      details: { url: frame.url() },
      source: "framenavigated",
    });
  };
  page.on("console", onConsole);
  page.on("framenavigated", onFrameNavigated);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.once("close", () => {
    page.off("console", onConsole);
    page.off("framenavigated", onFrameNavigated);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    controlUiE2ePageDiagnostics.delete(page);
  });
  controlUiE2ePageDiagnostics.set(page, events);
  return events;
}

export async function installControlUiE2eUnhandledRejectionRing(page: Page): Promise<void> {
  if (controlUiE2eUnhandledRejectionPages.has(page)) {
    return;
  }
  controlUiE2eUnhandledRejectionPages.add(page);
  await page.addInitScript(() => {
    const windowWithDiagnostics = window as Window & {
      __OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__?: Array<{
        at: string;
        reason: unknown;
      }>;
    };
    const events: Array<{ at: string; reason: unknown }> = [];
    windowWithDiagnostics["__OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__"] = events;
    window.addEventListener("unhandledrejection", (event) => {
      let reason: unknown;
      if (event.reason instanceof Error) {
        reason = {
          message: event.reason.message,
          name: event.reason.name,
          stack: event.reason.stack ?? null,
        };
      } else {
        try {
          reason = structuredClone(event.reason) as unknown;
        } catch {
          reason = String(event.reason);
        }
      }
      events.push({ at: new Date().toISOString(), reason });
      if (events.length > 200) {
        events.splice(0, events.length - 200);
      }
    });
  });
}

const controlUiRpcDiagnostics = new WeakMap<Page, Array<{ method: string; outcome: string }>>();

/** Observe only method/outcome facts; never retain Gateway payloads or authority. */
export function installControlUiRpcDiagnostics(page: Page): void {
  const events: Array<{ method: string; outcome: string }> = [];
  controlUiRpcDiagnostics.set(page, events);
  const record = (method: string, outcome: string) => {
    events.push({ method, outcome });
    if (events.length > 32) {
      events.shift();
    }
  };
  page.on("websocket", (socket) => {
    const pending = new Map<string, string>();
    socket.on("framesent", ({ payload }) => {
      try {
        const frame = asOptionalRecord(JSON.parse(String(payload)));
        if (
          frame?.type === "req" &&
          typeof frame.id === "string" &&
          typeof frame.method === "string" &&
          [
            "agents.list",
            "agents.files.list",
            "agents.files.get",
            "agents.files.set",
            "canvas.document.view",
          ].includes(frame.method)
        ) {
          if (pending.size >= 32) {
            pending.delete(pending.keys().next().value!);
          }
          pending.set(frame.id, frame.method);
          record(frame.method, "sent");
        }
      } catch {
        // Non-JSON frames carry no diagnostic facts.
      }
    });
    socket.on("framereceived", ({ payload }) => {
      try {
        const frame = asOptionalRecord(JSON.parse(String(payload)));
        const id = frame?.type === "res" && typeof frame.id === "string" ? frame.id : undefined;
        const method = id ? pending.get(id) : undefined;
        if (method && id) {
          pending.delete(id);
          record(method, frame?.ok === true ? "ok" : "error");
        }
      } catch {
        // Non-JSON frames carry no diagnostic facts.
      }
    });
    socket.on("close", () => pending.clear());
  });
}

type ControlUiE2eFailureDiagnosticsOptions = {
  error: Error;
  label: string;
  pageErrors?: string[];
  pageEvents?: ControlUiE2eDiagnosticEvent[];
  modelResponses?: { list?: unknown; authStatus?: unknown };
};

function summarizeRecordedModelResponses(
  responses: NonNullable<ControlUiE2eFailureDiagnosticsOptions["modelResponses"]>,
) {
  const list = asOptionalRecord(responses.list);
  const auth = asOptionalRecord(responses.authStatus);
  const catalog = asOptionalRecord(list?.payload);
  const health = asOptionalRecord(auth?.payload);
  const models = Array.isArray(catalog?.models) ? catalog.models : undefined;
  const profiles = Array.isArray(health?.providers)
    ? health.providers.flatMap((provider) => {
        const record = asOptionalRecord(provider);
        return Array.isArray(record?.profiles) ? record.profiles : [];
      })
    : undefined;
  const statusCounts = (entries: unknown, allowed: string[]) => {
    if (!Array.isArray(entries)) {
      return null;
    }
    const statuses = entries.map(
      (entry) => allowed.find((status) => asOptionalRecord(entry)?.status === status) ?? "unknown",
    );
    return Object.fromEntries(
      [...allowed, "unknown"].map((status) => [
        status,
        statuses.filter((entry) => entry === status).length,
      ]),
    );
  };
  return {
    listSeen: responses.list !== undefined,
    listOk: typeof list?.ok === "boolean" ? list.ok : null,
    models: models?.length ?? null,
    available:
      models?.filter((model) => asOptionalRecord(model)?.available === true).length ?? null,
    unavailable:
      models?.filter((model) => asOptionalRecord(model)?.available === false).length ?? null,
    unknownAvailability:
      models?.filter((model) => typeof asOptionalRecord(model)?.available !== "boolean").length ??
      null,
    pendingProviders: Array.isArray(catalog?.pendingProviders)
      ? catalog.pendingProviders.length
      : null,
    providerOutcomes: statusCounts(catalog?.providerOutcomes, [
      "ready",
      "auth-rejected",
      "unavailable",
    ]),
    authSeen: responses.authStatus !== undefined,
    authOk: typeof auth?.ok === "boolean" ? auth.ok : null,
    profiles: statusCounts(profiles, ["ok", "expiring", "expired", "missing", "static"]),
  };
}

/**
 * Capture a screenshot plus a browser/app-state report for a failed E2E wait.
 * Wired into mock-Gateway request timeouts automatically; boot/readiness waits
 * in individual tests should call this from their failure path so CI artifacts
 * explain stalls instead of surfacing all-null poll snapshots.
 */
export async function captureControlUiE2eFailureDiagnostics(
  page: Page,
  options: ControlUiE2eFailureDiagnosticsOptions,
): Promise<void> {
  try {
    await captureControlUiE2eFailureDiagnosticsUnsafe(page, options);
  } catch {
    console.error("[control-ui-e2e] failed to capture failure diagnostics");
  }
}

async function captureControlUiE2eFailureDiagnosticsUnsafe(
  page: Page,
  {
    error,
    label,
    pageErrors = [],
    // The mock-Gateway installer keeps a per-page diagnostic ring; default to
    // it so ad-hoc test callers get console/navigation history for free.
    pageEvents = controlUiE2ePageDiagnostics.get(page) ?? [],
    modelResponses,
  }: ControlUiE2eFailureDiagnosticsOptions,
): Promise<void> {
  // Renderer reads have no Playwright timeout; failure capture must not hold the original error.
  const deadline = performance.now() + 5_000;
  const captureErrors: string[] = [];
  let browserState: unknown = null;
  let summary: unknown = { available: false };
  try {
    const readBrowserState = page.evaluate(() => {
      const copy = (value: unknown): unknown => {
        try {
          return structuredClone(value) as unknown;
        } catch {
          return String(value);
        }
      };
      type Runtime = {
        context?: {
          agents?: {
            state?: {
              agentsError?: unknown;
              agentsList?: unknown;
              agentsLoading?: unknown;
              connected?: unknown;
            };
          };
          agentSelection?: { state?: unknown };
          gateway?: {
            snapshot?: { assistantAgentId?: unknown; hello?: unknown; phase?: unknown };
          };
          router?: { getState?: () => unknown };
        };
        router?: { getState?: () => unknown };
      };
      type MockGateway = {
        requests?: unknown[];
        socketStates?: () => Array<{ readyState: number; state: string; url: string }>;
        socketUrls?: () => string[];
      };
      const windowState = window as Window & {
        __OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__?: unknown[];
        openclawControlUiE2eGateway?: MockGateway;
      };
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { runtime?: Runtime })
        | null;
      const shell = document.querySelector("openclaw-app-shell") as
        | (HTMLElement & { runtime?: Runtime })
        | null;
      const runtime = app?.runtime ?? shell?.runtime;
      const context = runtime?.context;
      const agentsState = context?.agents?.state;
      const gatewaySnapshot = context?.gateway?.snapshot;
      const routerState = runtime?.router?.getState?.() ?? context?.router?.getState?.();
      const summarizeMatches = (matches: unknown): unknown =>
        Array.isArray(matches)
          ? matches.map((match) => {
              if (!match || typeof match !== "object") {
                return copy(match);
              }
              const record = match as Record<string, unknown>;
              return {
                pathname: copy(record.pathname ?? record.path ?? null),
                routeId: copy(record.routeId ?? record.id ?? null),
              };
            })
          : copy(matches ?? []);
      const customElementCounts: Record<string, number> = {};
      for (const element of document.querySelectorAll("*")) {
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
      const sendLabel = send?.getAttribute("aria-label");
      // Submit-disabled labels can contain server errors. Only known static UI copy
      // may reach CI logs; private reports retain the existing detailed state.
      const safeValue = (value: unknown, allowed: string[]) =>
        allowed.find((entry) => entry === value) ?? "unknown";
      const agentPage = document.querySelector("openclaw-agents-page");
      const selectedAgent = agentPage ? Reflect.get(agentPage, "agentsSelectedId") : undefined;
      const fileList = agentPage ? Reflect.get(agentPage, "agentFilesList") : undefined;
      const fileEditor = document.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
      const agentPath = window.location.pathname.match(
        /^\/settings\/agents\/([^/]+)\/(overview|files|tools|skills|channels|cron)$/u,
      );
      return {
        failureSummary: {
          canvasWidgets: [...document.querySelectorAll("openclaw-canvas-widget-view")]
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
            panel: safeValue(agentPage ? Reflect.get(agentPage, "agentsPanel") : undefined, [
              "overview",
              "files",
              "tools",
              "skills",
              "channels",
              "cron",
            ]),
            activeFile: safeValue(
              agentPage ? Reflect.get(agentPage, "agentFileActive") : undefined,
              [
                "AGENTS.md",
                "SOUL.md",
                "USER.md",
                "BOOTSTRAP.md",
                "MEMORY.md",
                "IDENTITY.md",
                "TOOLS.md",
                "HEARTBEAT.md",
              ],
            ),
            loading: agentPage ? Reflect.get(agentPage, "agentFilesLoading") === true : null,
            editorPresent: Boolean(fileEditor),
            editorLength: fileEditor?.value.length ?? null,
            editorDisabled: fileEditor?.disabled ?? null,
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
          connected: typeof agentsState?.connected === "boolean" ? agentsState.connected : null,
          roster: {
            loading:
              typeof agentsState?.agentsLoading === "boolean" ? agentsState.agentsLoading : null,
            count: Array.isArray(roster?.agents) ? roster.agents.length : null,
            errorPresent: Boolean(agentsState?.agentsError),
          },
          documentReadyState: safeValue(document.readyState, [
            "loading",
            "interactive",
            "complete",
          ]),
          providerStatuses: [
            ...document.querySelectorAll(".model-providers__head .settings-status"),
          ]
            .slice(0, 8)
            .map((badge) => {
              const text = badge.textContent?.trim();
              return {
                status: safeValue(text, ["Ready", "Signed in", "Configured", "Failed"]),
                length: text?.length ?? 0,
              };
            }),
          composer: textarea
            ? {
                draftLength: textarea.value.length,
                nonempty: textarea.value.length > 0,
                disabled: textarea.disabled,
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
        app: {
          agentSelection: copy(context?.agentSelection?.state ?? null),
          gateway: {
            assistantAgentId: copy(gatewaySnapshot?.assistantAgentId ?? null),
            hello: copy(gatewaySnapshot?.hello ?? null),
            phase: copy(gatewaySnapshot?.phase ?? null),
          },
          roster: {
            agentsError: copy(agentsState?.agentsError ?? null),
            agentsList: copy(agentsState?.agentsList ?? null),
            agentsLoading: copy(agentsState?.agentsLoading ?? null),
            connected: copy(agentsState?.connected ?? null),
          },
          router:
            routerState && typeof routerState === "object"
              ? {
                  matches: summarizeMatches((routerState as { matches?: unknown }).matches),
                  pendingMatches: summarizeMatches(
                    (routerState as { pendingMatches?: unknown }).pendingMatches,
                  ),
                  resolvedLocation: copy(
                    (routerState as { resolvedLocation?: unknown }).resolvedLocation ?? null,
                  ),
                  status: copy((routerState as { status?: unknown }).status ?? null),
                }
              : copy(routerState ?? null),
        },
        document: {
          customElementCounts,
          hasApp: Boolean(app),
          hasShell: Boolean(shell),
          readyState: document.readyState,
          // A stalled or failed bundle fetch shows as a script src with no
          // matching completed resource entry (resource timing only records
          // finished requests).
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
    });
    const { failureSummary, ...state } = await withTimeout(
      readBrowserState,
      Math.max(1, deadline - performance.now()),
      "page.evaluate diagnostics",
    );
    summary = failureSummary;
    browserState = state;
  } catch (evaluateError) {
    captureErrors.push(`page.evaluate: ${String(evaluateError)}`);
  }
  const models = modelResponses ? summarizeRecordedModelResponses(modelResponses) : null;
  const app = asOptionalRecord(asOptionalRecord(browserState)?.app);
  const router = asOptionalRecord(app?.router);
  const matches = Array.isArray(router?.matches) ? router.matches : null;
  const routeId = asOptionalRecord(matches?.[0])?.routeId;
  const knownRoute = typeof routeId === "string" && isRouteId(routeId) ? routeId : null;
  const pathname = asOptionalRecord(router?.resolvedLocation)?.pathname;
  const frameDepthCounts: number[] = [];
  for (const frame of page.frames()) {
    let depth = 0;
    let parent = frame.parentFrame();
    // Bucket deeper descendants together without retaining frame URLs or content.
    while (parent && depth < 8) {
      depth += 1;
      parent = parent.parentFrame();
    }
    frameDepthCounts[depth] = (frameDepthCounts[depth] ?? 0) + 1;
  }
  const publicSummary = {
    schemaVersion: 1,
    failureKind:
      error.name === "TimeoutError"
        ? "timeout"
        : error.name === "AssertionError"
          ? "assertion"
          : error.name === "AbortError"
            ? "abort"
            : error.name === "Error"
              ? "error"
              : "unknown",
    browser: summary,
    models,
    gatewayRpc: controlUiRpcDiagnostics.get(page) ?? [],
    frameDepthCounts,
    route: {
      pathname: knownRoute ? pathForRoute(knownRoute) : null,
      agentPanel:
        knownRoute === "agents" && typeof pathname === "string"
          ? (agentRouteFromPath(pathname)?.panel ?? null)
          : null,
      status:
        ["idle", "loading", "success", "error", "notFound", "redirected"].find(
          (status) => status === router?.status,
        ) ?? "unknown",
      matches: matches?.length ?? null,
      pendingMatches: Array.isArray(router?.pendingMatches) ? router.pendingMatches.length : null,
    },
  };
  // Only this allowlist reaches logs and automatic uploads; raw paths and errors stay private.
  console.error("[control-ui-e2e] failure state", JSON.stringify(publicSummary));
  const configuredDir = process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim();
  const artifactDir = createControlUiE2eArtifactDir(
    "failure",
    configuredDir ||
      path.resolve(import.meta.dirname, "../../../.artifacts/control-ui-e2e-timeouts/local"),
  );
  writeFileSync(
    path.join(artifactDir, "failure.public.json"),
    `${JSON.stringify(publicSummary, null, 2)}\n`,
    "utf8",
  );
  // Exclusive capture directories make label-derived filenames unnecessary and unsafe to log.
  const screenshotName = "failure.private.png";
  const screenshotPath = path.join(artifactDir, screenshotName);
  const reportPath = path.join(artifactDir, "failure.private.json");
  let screenshotWritten = false;
  const remainingMs = deadline - performance.now();
  if (remainingMs > 0) {
    try {
      // Keep writes here so a renderer reply after the deadline cannot publish a late artifact.
      const screenshot = await withTimeout(
        page.screenshot({ fullPage: true, timeout: remainingMs }),
        remainingMs,
        "page.screenshot diagnostics",
      );
      writeFileSync(screenshotPath, screenshot);
      screenshotWritten = true;
    } catch (screenshotError) {
      captureErrors.push(`page.screenshot: ${String(screenshotError)}`);
    }
  }
  const report = {
    schemaVersion: 2,
    label,
    browserState,
    captureErrors,
    capturedAt: new Date().toISOString(),
    ci: {
      githubJob: process.env.GITHUB_JOB ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      shardIndex: process.env.VITEST_SHARD_INDEX ?? null,
      vitestShardCount: process.env.VITEST_SHARD_COUNT ?? null,
    },
    pageEvents: [...pageEvents],
    pageErrors: [...pageErrors],
    page: {
      closed: page.isClosed(),
      url: page.url(),
    },
    screenshot: screenshotWritten ? screenshotName : null,
    failure: {
      message: error.message,
      name: error.name,
      stack: error.stack ?? null,
    },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[control-ui-e2e] failure diagnostics: ${reportPath}`);
  if (screenshotWritten) {
    console.error(`[control-ui-e2e] failure screenshot: ${screenshotPath}`);
  }
}
