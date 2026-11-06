import { loadActivatedBundledPluginPublicSurfaceModule } from "./facade-runtime.js";

/** A vetted local unpacked Manifest V3 extension; the operator owns installation and updates. */
export type BrowserExtensionRequest = {
  profile: string;
  /** Stable identity of the person whose browser this is, never an access token. */
  principal: string;
  extension: { id: string; unpackedPath: string; minimumVersion?: string };
};

/** Task-scoped attachment to an extension worker in one managed browser instance. */
export interface ExtensionHostSession {
  /**
   * Run closure-free code in the worker; arguments and results must be JSON-serializable.
   * The result is untrusted extension output, so callers validate its shape.
   */
  callInServiceWorker<A>(fn: (args: A) => unknown, args: A): Promise<unknown>;
  /** Resolve an OpenClaw tab handle or raw target id; ambiguous same-URL tabs fail closed. */
  resolveChromeTabId(tab: { targetId: string }): Promise<number>;
  /**
   * Exclude browser reads/actions while fn runs. Conflicts fail with a clear busy error.
   * While a live screencast or trace observes the profile, it rejects before fn runs with
   * an Error whose `code` is `"tabObserved"`; retry after the observer stops.
   */
  withExclusiveTab<R>(tab: { targetId: string }, fn: () => Promise<R>): Promise<R>;
  /** Detach the worker. Retained methods reject after closure. */
  close(): Promise<void>;
}

/** Launch-time declaration owned by one plugin and one person, until explicitly closed. */
export interface BrowserExtensionRegistration {
  /** Launch if necessary and attach the worker. Close every task session in finally. */
  openSession(options?: { timeoutMs?: number }): Promise<ExtensionHostSession>;
  /** Stop the owned profile before releasing its declaration; never silently unload mid-task. */
  close(): Promise<void>;
}

/** Declare a vetted extension before browser launch, without changing browser configuration. */
export async function registerBrowserExtension(
  request: BrowserExtensionRequest,
): Promise<BrowserExtensionRegistration> {
  const facade = await loadActivatedBundledPluginPublicSurfaceModule<{
    registerBrowserExtension(
      request: BrowserExtensionRequest,
    ): Promise<BrowserExtensionRegistration>;
  }>({ dirName: "browser", artifactBasename: "extension-host-api.js" });
  return await facade.registerBrowserExtension(request);
}
