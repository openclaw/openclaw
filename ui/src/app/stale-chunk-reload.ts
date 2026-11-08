import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Stale hashed-chunk recovery for lazy routes and the entry stylesheet.
//
// A gateway update replaces `dist/control-ui` in place, so a document loaded before the
// update still references the old hashed chunk URLs; the first visit to a lazy
// route after the update 404s and the dynamic import rejects ("Importing a
// module script failed"). Reload the freshly served document in every browser,
// including WKWebView and plain-HTTP LAN origins without a service worker.
// Worker update announcements use this same guarded recovery; unsaved work
// blocks automatic reloads and leaves the Reload banner available.
import { raceWithTimeout, sleepWithAbort } from "@openclaw/retry";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { configuredUiDevGateway } from "../dev-gateway.ts";
import { t } from "../i18n/index.ts";
import { listen } from "../lib/reactive/listener.ts";
import { getSafeSessionStorage } from "../local-storage.ts";
import { resolveControlUiPaths } from "./browser.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";
import { trackForegroundActivity } from "./foreground-activity.ts";

const RELOAD_GUARD_STORAGE_KEY = "openclaw.controlUi.staleChunkReloadBuildId";
const RENDER_RELOAD_STORAGE_KEY = "openclaw.controlUi.renderErrorReloadAttempted";
// Bounds document probes across rapid re-renders of the same error state.
const ATTEMPT_COOLDOWN_MS = 5_000;
// Allow slow links to answer; callers share the in-flight probe.
const DOCUMENT_PROBE_TIMEOUT_MS = 10_000;
const BUILD_RELOAD_JITTER_MS = 2_000;
const RELOAD_GUARD_WINDOW_MS = 30_000;

// WebKit, Chromium, Firefox, and Vite's preload helper use these four phrases.
const MODULE_IMPORT_ERROR_PATTERN =
  /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload css/i;

type StaleChunkReloadDeps = {
  buildId?: string;
  reloadOnce?: boolean;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  reload?: () => void;
  canReload?: () => boolean;
  checkServingBuild?: boolean;
};

type RecoveryState = {
  buildId: string | null;
  attemptedAt: number;
  pending?: Promise<boolean>;
  controller?: AbortController;
  checkServingBuild?: boolean;
};

const recoveryByStorage = new WeakMap<object, RecoveryState>();
const unavailableStorage = {};
let importReachability: Promise<boolean> | undefined;
// A shared probe can release automatic and manual recovery in the same microtask.
// Admit one navigation before either path can replace the guard or reload.
let inFlightDocumentProbe: Promise<boolean> | null = null;

// These browser errors identify failed assets, not whether the deployed build changed.
export function isStaleChunkImportError(error: unknown): error is Error {
  return error instanceof Error && MODULE_IMPORT_ERROR_PATTERN.test(error.message);
}

function waitForImportReachability(): Promise<boolean> {
  return (importReachability ??= waitForReachableControlUiDocument(
    { timeoutMs: Infinity },
    () => true,
  ).finally(() => {
    importReachability = undefined;
  }));
}

/** Keep an import pending through an outage, then retry before considering a stale build. */
export async function retryControlUiImport<T>(
  load: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await trackForegroundActivity(Promise.resolve(load()));
  } catch (error) {
    return retryFailedControlUiImport(error, load, signal);
  }
}

/** Reuse a failed attempt when the import started before the retry owner was loaded. */
export async function retryFailedControlUiImport<T>(
  error: unknown,
  load: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!isStaleChunkImportError(error)) {
    throw error;
  }
  await waitForImportReachability();
  signal?.throwIfAborted();
  // Vite marks CSS preloads seen before they finish; retrying can mount an unstyled page.
  if (/unable to preload css/i.test(error.message)) {
    throw error;
  }
  // Persistent module-map failures still reach the caller's guarded error surface.
  return trackForegroundActivity(Promise.resolve(load()));
}

export function reloadControlUiDocument(url = new URL(window.location.href)): void {
  // The pre-app mount recovery strips this one-shot cache buster before bootstrap.
  url.searchParams.set("openclaw_mount_recovery", String(Date.now()));
  window.location.replace(url.href);
}

function controlUiDocumentUrl(): string {
  // Probe the serving document without session query data.
  const url = new URL(window.location.href);
  const [routeBasePath, resourceBasePath] = resolveControlUiPaths(url.pathname);
  // Vite serves its own document while Gateway resources use the development proxy.
  const documentBasePath = configuredUiDevGateway() ? routeBasePath : resourceBasePath;
  url.pathname = `${documentBasePath}/index.html`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function probeControlUiDocument(): Promise<boolean> {
  if (inFlightDocumentProbe) {
    return inFlightDocumentProbe;
  }
  inFlightDocumentProbe = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOCUMENT_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(controlUiDocumentUrl(), {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    inFlightDocumentProbe = null;
  });
  return inFlightDocumentProbe;
}

function persistGuardBuildId(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  buildId: string,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(RELOAD_GUARD_STORAGE_KEY, JSON.stringify({ buildId, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reload the document so stale hashed chunks resolve against the freshly
 * served index.html. Returns whether a reload was initiated. Reloads only when
 * the gateway answers a document probe — while it is restarting, a reload
 * would replace the whole document with a navigation error (fatal inside the
 * app webviews) instead of the recoverable panel error.
 */
export async function scheduleStaleChunkReload(deps: StaleChunkReloadDeps = {}): Promise<boolean> {
  if (deps.canReload?.() === false || !canReloadControlUiDocument()) {
    return false;
  }
  const storage = deps.storage === undefined ? getSafeSessionStorage() : deps.storage;
  const buildId = deps.buildId ?? CONTROL_UI_BUILD_INFO.buildId;
  // A recent automatic reload of this build defers the next one instead of refusing it:
  // a broken build reloads at most once per window, while a later network blip still
  // recovers on its own.
  let guardDelayMs = 0;
  try {
    const guard = JSON.parse(storage?.getItem(RELOAD_GUARD_STORAGE_KEY) ?? "null");
    // Rejected handshakes must settle on visible recovery guidance, not a timer
    // that keeps replacing an incompatible bundle. Also bound alternating builds.
    if (
      deps.reloadOnce &&
      (guard?.buildId === buildId ||
        (typeof guard?.at === "number" && Date.now() - guard.at < 60_000))
    ) {
      return false;
    }
    if (guard?.buildId === buildId && typeof guard.at === "number") {
      guardDelayMs = Math.max(0, guard.at + RELOAD_GUARD_WINDOW_MS - Date.now());
    }
  } catch {
    // Unreadable storage follows the same safe path as unavailable storage.
  }
  const now = Date.now();
  const storageIdentity = storage ?? unavailableStorage;
  let recovery = recoveryByStorage.get(storageIdentity);
  // This document already issued a reload and is being replaced.
  if (recovery?.buildId === null) {
    return false;
  }
  // A generic chunk failure cannot replace the server build already being
  // recovered. Only the Gateway owns a new target artifact and retry lifetime.
  if (deps.buildId === undefined && recovery?.pending && recovery.buildId !== buildId) {
    return false;
  }
  const supersedesClassification = recovery?.checkServingBuild && !deps.checkServingBuild;
  if (
    recovery?.buildId === buildId &&
    !recovery.pending &&
    !supersedesClassification &&
    now - recovery.attemptedAt < ATTEMPT_COOLDOWN_MS
  ) {
    return false;
  }
  // A surface's explicit reload supersedes the global listener's build classification.
  if (recovery?.buildId !== buildId || !recovery.pending || supersedesClassification) {
    recovery?.controller?.abort();
    const controller = new AbortController();
    const target: RecoveryState = {
      buildId,
      attemptedAt: now,
      controller,
      checkServingBuild: deps.checkServingBuild,
    };
    recoveryByStorage.set(storageIdentity, target);
    // Reachability is shared by build, not owned by the first caller's connection.
    // Each caller checks its current authority at the reload below.
    const wait = () => {
      const reachable = waitForReachableControlUiDocument(
        { timeoutMs: deps.buildId === undefined ? Infinity : undefined },
        () =>
          recoveryByStorage.get(storageIdentity) === target &&
          target.buildId === buildId &&
          canReloadControlUiDocument(),
        controller.signal,
      );
      if (!target.checkServingBuild) {
        return reachable;
      }
      return reachable.then(async (available) => {
        if (!available) {
          return false;
        }
        try {
          const response = await fetch(controlUiDocumentUrl(), {
            cache: "no-store",
            headers: { "X-OpenClaw-Reachability-Probe": "1" },
            signal: AbortSignal.timeout(DOCUMENT_PROBE_TIMEOUT_MS),
          });
          if (!response.ok) {
            return false;
          }
          // Public-asset/cache stamps can survive updates; use the full build identity.
          const encoded = /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(.*?);<\/script>/u.exec(
            await response.text(),
          )?.[1];
          const buildInfo: unknown = encoded ? JSON.parse(encoded) : null;
          return !isRecord(buildInfo) || buildInfo.buildId !== CONTROL_UI_BUILD_INFO.buildId;
        } catch {
          // A second interruption cannot justify replacing a usable document.
          return false;
        }
      });
    };
    const delayMs = Math.max(
      guardDelayMs,
      deps.buildId === undefined ? 0 : Math.floor(Math.random() * BUILD_RELOAD_JITTER_MS),
    );
    target.pending =
      delayMs > 0 ? sleepWithAbort(delayMs, controller.signal).then(wait, () => false) : wait();
    recovery = target;
  }
  try {
    if (!(await recovery.pending)) {
      return false;
    }
  } finally {
    recovery.pending = undefined;
    recovery.attemptedAt = Date.now();
  }
  // A reload resets the in-memory state, so without a persisted guard a broken
  // build would reload forever. When storage is unavailable or rejects the
  // write, leave recovery to the manual Retry path instead of reloading.
  const reload = deps.reload ?? reloadControlUiDocument;
  if (
    !canReloadControlUiDocument() ||
    deps.canReload?.() === false ||
    recoveryByStorage.get(storageIdentity) !== recovery ||
    recovery.buildId !== buildId ||
    !persistGuardBuildId(storage, buildId)
  ) {
    return false;
  }
  recovery.buildId = null;
  reload();
  return true;
}

/** Render bugs get one automatic reload per tab, not the stale-asset retry loop. */
export async function reloadAfterRenderErrorOnce(
  deps: Omit<StaleChunkReloadDeps, "buildId"> = {},
): Promise<boolean> {
  const storage = deps.storage === undefined ? getSafeSessionStorage() : deps.storage;
  if (!storage || deps.canReload?.() === false || !canReloadControlUiDocument()) {
    return false;
  }
  try {
    if (storage.getItem(RENDER_RELOAD_STORAGE_KEY) !== null) {
      return false;
    }
  } catch {
    return false;
  }
  // Do not replace a recoverable error with a browser network-error document.
  if (!(await waitForReachableControlUiDocument({ timeoutMs: 0 }, () => true))) {
    return false;
  }
  if (deps.canReload?.() === false || !canReloadControlUiDocument()) {
    return false;
  }
  try {
    // Recheck after the shared probe: another failing surface may have claimed it.
    if (storage.getItem(RENDER_RELOAD_STORAGE_KEY) !== null) {
      return false;
    }
    // Never clear on mount, Retry, or a timer: a persistent bug must stay stopped.
    storage.setItem(RENDER_RELOAD_STORAGE_KEY, "1");
  } catch {
    return false;
  }
  (deps.reload ?? reloadControlUiDocument)();
  return true;
}

// A restarting gateway is the common case behind this banner: the stale chunk
// exists precisely because the gateway was just updated. Give the restart time
// to finish rather than declining the reload on the first failed probe.
const REACHABLE_WAIT_TIMEOUT_MS = 30_000;
const REACHABLE_WAIT_INTERVAL_MS = 1_000;

type ReachableReloadDeps = StaleChunkReloadDeps & {
  timeoutMs?: number;
};

async function waitForReachableControlUiDocument(
  deps: ReachableReloadDeps,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = performance.now() + (deps.timeoutMs ?? REACHABLE_WAIT_TIMEOUT_MS);
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted || !isCurrent()) {
      return false;
    }
    const remaining = deadline - performance.now();
    if (attempt > 0 && remaining <= 0) {
      return false;
    }
    // timeoutMs: 0 remains one bounded request.
    const reachable = await raceWithTimeout(
      probeControlUiDocument,
      remaining > 0 ? Math.min(remaining, DOCUMENT_PROBE_TIMEOUT_MS) : DOCUMENT_PROBE_TIMEOUT_MS,
      () => false,
    );
    if (signal?.aborted || !isCurrent()) {
      return false;
    }
    if (reachable) {
      return true;
    }
    const remainingWait = deadline - performance.now();
    if (remainingWait <= 0) {
      return false;
    }
    if (Number.isFinite(deadline)) {
      await sleepWithAbort(Math.min(REACHABLE_WAIT_INTERVAL_MS, remainingWait), signal).catch(
        () => {},
      );
    } else {
      await waitForRecoverySignal(Math.min(1_000 * 2 ** Math.min(attempt, 4), 15_000), signal);
    }
  }
}

function waitForRecoverySignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      stopOnline();
      stopVisibility();
      stopAbort?.();
      resolve();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        finish();
      }
    };
    const timer = setTimeout(finish, delayMs);
    const stopOnline = listen(window, "online", finish);
    const stopVisibility = listen(document, "visibilitychange", onVisibility);
    const stopAbort = signal && listen(signal, "abort", finish, { once: true });
    if (signal?.aborted) {
      finish();
    }
  });
}

/**
 * A dismissed failure surface retires pending recovery for the running build. Gateway
 * build targets keep theirs, and surfaces still showing a failure re-arm on render.
 */
export function cancelStaleChunkRecovery(
  storage: Pick<Storage, "getItem" | "setItem"> | null = getSafeSessionStorage(),
): void {
  const storageIdentity = storage ?? unavailableStorage;
  const recovery = recoveryByStorage.get(storageIdentity);
  if (recovery?.pending && recovery.buildId === CONTROL_UI_BUILD_INFO.buildId) {
    recovery.controller?.abort();
    // Unregister now: a surface failing before the aborted probe unwinds starts fresh.
    recoveryByStorage.delete(storageIdentity);
  }
}

/** User-initiated retry may bypass the automatic build guard, but never live ownership. */
export async function retryStaleChunkReloadWhenReachable(
  deps: ReachableReloadDeps = {},
): Promise<boolean> {
  // Automatic recovery keeps running: a manual retry during an outage may fail, and a
  // successful one retires the shared target before the automatic wait can reload.
  const storage = deps.storage === undefined ? getSafeSessionStorage() : deps.storage;
  const storageIdentity = storage ?? unavailableStorage;
  if (
    !(await waitForReachableControlUiDocument(
      deps,
      () => deps.canReload?.() !== false && canReloadControlUiDocument(true),
    )) ||
    deps.canReload?.() === false ||
    !canReloadControlUiDocument(true)
  ) {
    return false;
  }
  const reload = deps.reload ?? reloadControlUiDocument;
  const recovery = recoveryByStorage.get(storageIdentity) ?? {
    buildId: CONTROL_UI_BUILD_INFO.buildId,
    attemptedAt: Date.now(),
  };
  recoveryByStorage.set(storageIdentity, recovery);
  const buildId = recovery.buildId;
  if (buildId === null) {
    return false;
  }
  recovery.buildId = null;
  persistGuardBuildId(storage, buildId);
  reload();
  return true;
}

/** Classify caught failures by the serving build, including exhausted background retries. */
export function installStaleChunkReloadListener(): () => void {
  let active = true;
  const stop = listen(window, "vite:preloadError", (event: Event & { payload?: unknown }) => {
    if (isStaleChunkImportError(event.payload)) {
      // The existing target owns classification too, so dismissals retire the whole recovery.
      void scheduleStaleChunkReload({ checkServingBuild: true, canReload: () => active });
    }
  });
  return () => {
    active = false;
    stop();
  };
}

export function installMissingStylesheetRecovery(): () => void {
  let banner: HTMLDivElement | null = null;
  let stopLoad: (() => void) | undefined;

  function checkStylesheet() {
    if (
      getComputedStyle(document.documentElement).getPropertyValue("--openclaw-css-ok").trim() ===
      "1"
    ) {
      return;
    }
    banner = document.createElement("div");
    banner.role = "alert";
    // All styles are inline because the entry stylesheet is broken by definition.
    banner.style.cssText =
      "position:fixed;inset:0 0 auto;z-index:2147483647;padding:12px;text-align:center;background:#1f2937;color:#fff;font:14px system-ui";
    const reloadButton = document.createElement("button");
    reloadButton.textContent = t("common.reload");
    listen(reloadButton, "click", () => void retryStaleChunkReloadWhenReachable({ timeoutMs: 0 }));
    banner.append(t("lazyView.stylesFailed"), " ", reloadButton);
    document.body.append(banner);
    void scheduleStaleChunkReload();
  }

  // The entry stylesheet owns this sentinel. Individual resource errors include
  // optional fonts, themes and plugins, which must not initiate document recovery.
  if (document.readyState === "complete") {
    checkStylesheet();
  } else {
    stopLoad = listen(window, "load", checkStylesheet, { once: true });
  }

  return () => {
    stopLoad?.();
    banner?.remove();
    banner = null;
  };
}
