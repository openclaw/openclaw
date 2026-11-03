import { writeFileSync } from "node:fs";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConsoleMessage, Frame, Page, Request } from "playwright";
import { agentRouteFromPath, isRouteId, pathForRoute } from "../app-route-paths.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";
import { readControlUiE2eBrowserState } from "./control-ui-e2e-browser-state.ts";
import { captureControlUiE2eRendererStall } from "./control-ui-e2e-renderer-stall.ts";

const CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT = 200;
const controlUiE2ePageDiagnostics = new WeakMap<Page, ControlUiE2eDiagnosticEvent[]>();
const controlUiE2eUnhandledRejectionPages = new WeakSet<Page>();
export type ControlUiE2eFailureFact =
  | boolean
  | number
  | string
  | null
  | readonly ControlUiE2eFailureFact[]
  | { readonly [key: string]: ControlUiE2eFailureFact };
const controlUiE2eFailureFacts = new WeakMap<Page, Record<string, ControlUiE2eFailureFact>>();

/** Callers bound and redact facts; keys/string values are fixed labels, never content or IDs. */
export function recordControlUiE2eFailureFacts(
  page: Page,
  facts: Record<string, ControlUiE2eFailureFact>,
): void {
  controlUiE2eFailureFacts.set(page, { ...controlUiE2eFailureFacts.get(page), ...facts });
}
type ControlUiE2ePageLifecycle = {
  registeredAt: string;
  firstCrashAt: string | null;
  firstCloseAt: string | null;
  firstBrowserDisconnectAt: string | null;
};
// Retain only fixed host facts after close; missing events mean unobserved since registration.
const controlUiE2ePageLifecycles = new WeakMap<Page, ControlUiE2ePageLifecycle>();

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
  // A closed page loses its raw ring, but must not acquire new browser listeners.
  if (controlUiE2ePageLifecycles.has(page)) {
    return [];
  }
  const lifecycle: ControlUiE2ePageLifecycle = {
    registeredAt: new Date().toISOString(),
    firstCrashAt: null,
    firstCloseAt: null,
    firstBrowserDisconnectAt: null,
  };
  controlUiE2ePageLifecycles.set(page, lifecycle);
  if (page.isClosed()) {
    return [];
  }
  const browser = page.context().browser();
  const onCrash = () => {
    lifecycle.firstCrashAt ??= new Date().toISOString();
  };
  const onBrowserDisconnect = () => {
    lifecycle.firstBrowserDisconnectAt ??= new Date().toISOString();
  };
  const events: ControlUiE2eDiagnosticEvent[] = [];
  const push = (
    source: ControlUiE2eDiagnosticEvent["source"],
    details: ControlUiE2eDiagnosticEvent["details"],
  ) => {
    events.push({ at: new Date().toISOString(), source, details });
    if (events.length > CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT) {
      events.splice(0, events.length - CONTROL_UI_E2E_DIAGNOSTIC_RING_LIMIT);
    }
  };
  const onConsole = (message: ConsoleMessage) =>
    push("console", {
      location: message.location(),
      text: message.text(),
      type: message.type(),
    });
  const onPageError = (error: Error) =>
    push("pageerror", { message: error.message, name: error.name, stack: error.stack ?? null });
  const onRequestFailed = (request: Request) =>
    push("requestfailed", {
      errorText: request.failure()?.errorText ?? null,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
    });
  const onFrameNavigated = (frame: Frame) => {
    // Main-frame navigations order boot/reload sequences in failure reports;
    // subframes are noise.
    if (frame !== page.mainFrame()) {
      return;
    }
    push("framenavigated", { url: frame.url() });
  };
  page.on("console", onConsole);
  page.on("framenavigated", onFrameNavigated);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.once("crash", onCrash);
  if (browser?.isConnected()) {
    browser.once("disconnected", onBrowserDisconnect);
  }
  page.once("close", () => {
    lifecycle.firstCloseAt ??= new Date().toISOString();
    page.off("crash", onCrash);
    browser?.off("disconnected", onBrowserDisconnect);
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
    type Rejection = { at: string; reason: unknown };
    const windowWithDiagnostics = window as Window & {
      __OPENCLAW_CONTROL_UI_E2E_UNHANDLED_REJECTIONS__?: Rejection[];
    };
    const events: Rejection[] = [];
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
            "audit.run.inspect",
            "canvas.document.view",
            "chat.history",
            "chat.startup",
            "sessions.list",
            "sessions.subscribe",
            "sessions.unsubscribe",
            "sessions.messages.subscribe",
            "sessions.messages.unsubscribe",
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
  modelResponses?: { list?: unknown; snapshot?: unknown; authStatus?: unknown };
};

function summarizeRecordedModelResponses(
  responses: NonNullable<ControlUiE2eFailureDiagnosticsOptions["modelResponses"]>,
) {
  const array = (value: unknown): readonly unknown[] | undefined =>
    Array.isArray(value) ? value : undefined;
  const count = (value: readonly unknown[] | undefined) => value?.length ?? null;
  const list = asOptionalRecord(responses.list);
  const auth = asOptionalRecord(responses.authStatus);
  const snapshot = asOptionalRecord(responses.snapshot);
  const health = asOptionalRecord(auth?.payload);
  const profiles = array(health?.providers)?.flatMap(
    (provider) => array(asOptionalRecord(provider)?.profiles) ?? [],
  );
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
  const catalogCounts = (payload: unknown) => {
    const catalog = asOptionalRecord(payload);
    const models = array(catalog?.models);
    const availability = models?.map((model) => asOptionalRecord(model)?.available);
    return {
      models: count(models),
      available: count(availability?.filter((value) => value === true)),
      unavailable: count(availability?.filter((value) => value === false)),
      unknownAvailability: count(availability?.filter((value) => typeof value !== "boolean")),
      pendingProviders: count(array(catalog?.pendingProviders)),
      providerOutcomes: statusCounts(catalog?.providerOutcomes, [
        "ready",
        "auth-rejected",
        "unavailable",
      ]),
    };
  };
  return {
    listSeen: responses.list !== undefined,
    listOk: typeof list?.ok === "boolean" ? list.ok : null,
    ...catalogCounts(list?.payload),
    snapshot: {
      seen: responses.snapshot !== undefined,
      ...catalogCounts(asOptionalRecord(snapshot?.payload)?.catalog),
    },
    authSeen: responses.authStatus !== undefined,
    authOk: typeof auth?.ok === "boolean" ? auth.ok : null,
    profiles: statusCounts(profiles, ["ok", "expiring", "expired", "missing", "static"]),
  };
}

/** Capture failed waits; mock request timeouts call this automatically, readiness waits explicitly. */
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
    pageEvents = controlUiE2ePageDiagnostics.get(page) ?? [],
    modelResponses,
  }: ControlUiE2eFailureDiagnosticsOptions,
): Promise<void> {
  // Renderer reads have no Playwright timeout; failure capture must not hold the original error.
  const deadline = performance.now() + 5_000;
  const captureErrors: string[] = [];
  let browserState: unknown = null;
  let summary: unknown = { available: false };
  // These cached host flags survive an unavailable renderer; sample before the renderer read.
  const hostBeforeRead = {
    capturedAt: new Date().toISOString(),
    pageClosed: page.isClosed(),
    browserConnected: page.context().browser()?.isConnected() ?? null,
  };
  const rendererDeadlineError = new Error("page.evaluate diagnostics timed out");
  let rendererRead: "completed" | "rejected" | "deadline" = "completed";
  try {
    const readBrowserState = page.evaluate(readControlUiE2eBrowserState);
    const { failureSummary, ...state } = await withTimeout(
      readBrowserState,
      Math.max(1, deadline - performance.now()),
      { createError: () => rendererDeadlineError },
    );
    summary = failureSummary;
    browserState = state;
  } catch (evaluateError) {
    rendererRead = evaluateError === rendererDeadlineError ? "deadline" : "rejected";
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
  const failureKind =
    new Map([
      ["TimeoutError", "timeout"],
      ["AssertionError", "assertion"],
      ["AbortError", "abort"],
      ["Error", "error"],
    ]).get(error.name) ?? "unknown";
  const publicSummary = {
    schemaVersion: 1,
    failureKind,
    browser: summary,
    hostBeforeRead,
    lifecycle: controlUiE2ePageLifecycles.get(page) ?? null,
    rendererRead,
    rendererStall: await captureControlUiE2eRendererStall(page, rendererRead),
    models,
    retainedBrowserErrors: {
      console: pageEvents.filter(
        (event) => event.source === "console" && event.details.type === "error",
      ).length,
      page: pageEvents.filter((event) => event.source === "pageerror").length,
      scriptRequests: pageEvents.filter(
        (event) => event.source === "requestfailed" && event.details.resourceType === "script",
      ).length,
    },
    gatewayRpc: controlUiRpcDiagnostics.get(page) ?? [],
    scenarioFacts: controlUiE2eFailureFacts.get(page) ?? null,
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
