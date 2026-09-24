import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import {
  parseRemoteModelCatalogBundle,
  validateAndSanitizeRemoteModelCatalogBundle,
  type RemoteModelCatalogBundle,
  type RemoteModelCatalogPricing,
} from "@openclaw/model-catalog-core";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { VERSION } from "../version.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import { isRemoteModelCatalogRefreshEnabled, resolveRemoteCatalogUrl } from "./remote-config.js";
import { readRemoteModelCatalog, readRemoteModelCatalogAsync } from "./remote-store.js";

type RemoteModelCatalogOverlay = Readonly<Record<string, ModelCatalogProvider>>;
type RemoteModelCatalogMetadata = {
  sourceUrl: string;
  generatedAt: number;
};
type ActiveRemoteModelCatalog = RemoteModelCatalogMetadata & {
  providers: RemoteModelCatalogOverlay;
  pricing?: Readonly<Record<string, RemoteModelCatalogPricing>>;
};

const STARTUP_SNAPSHOT_KEY = "openclaw.remoteModelCatalogStartupSnapshot";
let readBundledGeneratedAt = bundledCatalogGeneratedAt;
let readStoredCatalog = readRemoteModelCatalog;
let readStoredCatalogAsync = readRemoteModelCatalogAsync;

function isCompatible(bundle: RemoteModelCatalogBundle, bundledGeneratedAt: number): boolean {
  if (bundle.generatedAt <= bundledGeneratedAt) {
    return false;
  }
  if (!bundle.minVersion) {
    return true;
  }
  const comparison = compareOpenClawVersions(VERSION, bundle.minVersion);
  return comparison !== null && comparison >= 0;
}

function readCompatibleRemoteModelCatalog(): ActiveRemoteModelCatalog | null {
  const bundledGeneratedAt = readBundledGeneratedAt();
  if (bundledGeneratedAt === undefined) {
    return null;
  }
  return selectCompatibleRemoteModelCatalog(readStoredCatalog(), bundledGeneratedAt);
}

function readCompatibleRemoteModelCatalogMetadata(): RemoteModelCatalogMetadata | null {
  const bundledGeneratedAt = readBundledGeneratedAt();
  if (bundledGeneratedAt === undefined) {
    return null;
  }
  const stored = readStoredCatalog();
  if (!stored) {
    return null;
  }
  const bundle = parseRemoteModelCatalogBundle(JSON.parse(stored.bundle_json));
  return isCompatible(bundle, bundledGeneratedAt)
    ? { sourceUrl: stored.source_url, generatedAt: bundle.generatedAt }
    : null;
}

function selectCompatibleRemoteModelCatalog(
  stored: ReturnType<typeof readRemoteModelCatalog>,
  bundledGeneratedAt: number,
): ActiveRemoteModelCatalog | null {
  if (!stored) {
    return null;
  }
  const bundle = validateAndSanitizeRemoteModelCatalogBundle(JSON.parse(stored.bundle_json));
  if (!isCompatible(bundle, bundledGeneratedAt)) {
    return null;
  }
  return {
    sourceUrl: stored.source_url,
    generatedAt: bundle.generatedAt,
    providers: bundle.providers,
    ...(bundle.pricing ? { pricing: bundle.pricing } : {}),
  };
}

function inheritedRemoteModelCatalogStartupSnapshot() {
  // SAFETY: This module alone sets the key to a record containing a validated snapshot or null.
  return getEnvironmentData(STARTUP_SNAPSHOT_KEY) as
    | { catalog: ActiveRemoteModelCatalog | null }
    | undefined;
}

function publishRemoteModelCatalogStartupSnapshot(
  snapshot: ActiveRemoteModelCatalog | null,
): ActiveRemoteModelCatalog | null {
  const inherited = inheritedRemoteModelCatalogStartupSnapshot();
  if (inherited !== undefined) {
    return inherited.catalog;
  }
  // New workers inherit the startup pair, including absence, rather than later downloads.
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, { catalog: snapshot });
  return snapshot;
}

export function captureRemoteModelCatalogStartupSnapshot(): ActiveRemoteModelCatalog | null {
  const inherited = inheritedRemoteModelCatalogStartupSnapshot();
  if (inherited !== undefined) {
    return inherited.catalog;
  }
  let snapshot: ActiveRemoteModelCatalog | null;
  try {
    snapshot = readCompatibleRemoteModelCatalog();
  } catch {
    snapshot = null;
  }
  return publishRemoteModelCatalogStartupSnapshot(snapshot);
}

/** Prepare the same first-winner startup pair without host-thread SQLite reads. */
export async function prepareRemoteModelCatalogStartupSnapshot(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ActiveRemoteModelCatalog | null> {
  const inherited = inheritedRemoteModelCatalogStartupSnapshot();
  if (inherited !== undefined) {
    return inherited.catalog;
  }
  let bundledGeneratedAt: number | undefined;
  try {
    bundledGeneratedAt = readBundledGeneratedAt();
  } catch {
    return publishRemoteModelCatalogStartupSnapshot(null);
  }
  if (bundledGeneratedAt === undefined) {
    return publishRemoteModelCatalogStartupSnapshot(null);
  }
  const context = captureOpenClawStateWorkerContext(options);
  let snapshot: ActiveRemoteModelCatalog | null;
  try {
    snapshot = selectCompatibleRemoteModelCatalog(
      await readStoredCatalogAsync(context),
      bundledGeneratedAt,
    );
  } catch {
    snapshot = null;
  }
  // Optional read/parse failures are absence; retired work cannot publish that absence.
  context.admission.assertCurrent();
  return publishRemoteModelCatalogStartupSnapshot(snapshot);
}

function getActiveRemoteModelCatalog(config: OpenClawConfig): ActiveRemoteModelCatalog | undefined {
  if (!isRemoteModelCatalogRefreshEnabled(config)) {
    return undefined;
  }
  const snapshot = captureRemoteModelCatalogStartupSnapshot();
  return snapshot?.sourceUrl === resolveRemoteCatalogUrl(config) ? snapshot : undefined;
}

/** Inspects a completed check without activating its download or replacing the startup pair. */
export function checkRemoteModelCatalogUpdate(
  config: OpenClawConfig,
  expected: { sourceUrl: string; generatedAt: number },
): "restart-required" | "unchanged" | "superseded" {
  if (
    !isRemoteModelCatalogRefreshEnabled(config) ||
    resolveRemoteCatalogUrl(config) !== expected.sourceUrl
  ) {
    return "superseded";
  }
  if (getActiveRemoteModelCatalog(config)?.generatedAt === expected.generatedAt) {
    return "unchanged";
  }
  const stored = readCompatibleRemoteModelCatalogMetadata();
  if (!stored) {
    return "unchanged";
  }
  return stored.sourceUrl === expected.sourceUrl && stored.generatedAt === expected.generatedAt
    ? "restart-required"
    : "superseded";
}

export function getRemoteModelCatalogProviderOverlay(
  config: OpenClawConfig,
  provider: string,
): ModelCatalogProvider | undefined {
  const providerId = normalizeProviderId(provider);
  return providerId ? getActiveRemoteModelCatalog(config)?.providers[providerId] : undefined;
}

export function getRemoteModelCatalogPricing(
  config: OpenClawConfig,
): Readonly<Record<string, RemoteModelCatalogPricing>> | undefined {
  return getActiveRemoteModelCatalog(config)?.pricing;
}

function setRemoteModelCatalogOverlaySourcesForTest(sources?: {
  bundledGeneratedAt?: typeof bundledCatalogGeneratedAt;
  readStoredCatalog?: typeof readRemoteModelCatalog;
}): void {
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, undefined);
  readBundledGeneratedAt = sources?.bundledGeneratedAt ?? bundledCatalogGeneratedAt;
  readStoredCatalog = sources?.readStoredCatalog ?? readRemoteModelCatalog;
  const readTestCatalog = sources?.readStoredCatalog;
  readStoredCatalogAsync = readTestCatalog
    ? async () => readTestCatalog()
    : readRemoteModelCatalogAsync;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.remoteModelCatalogOverlayTestApi")
  ] = {
    setRemoteModelCatalogOverlaySourcesForTest,
  };
}
