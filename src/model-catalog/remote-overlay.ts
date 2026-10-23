import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { VERSION } from "../version.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import {
  parseRemoteModelCatalogWireBundle,
  projectRemoteModelCatalog,
  type RemoteModelCatalogPrice,
  type RemoteModelCatalogUpstreamPrice,
  type RemoteModelCatalogWireBundle,
} from "./remote-bundle.js";
import {
  isRemoteCatalogSourceActive,
  isRemoteModelCatalogRefreshEnabled,
} from "./remote-config.js";
import { readRemoteModelCatalogAsync } from "./remote-store.js";

export type RemoteCatalogPublicationResult = "published" | "unchanged" | "superseded";

type RemoteModelCatalogOverlay = Readonly<Record<string, ModelCatalogProvider>>;
type RemoteModelCatalogMetadata = {
  sourceUrl: string;
  generatedAt: number;
};
export type ActiveRemoteModelCatalog = RemoteModelCatalogMetadata & {
  revision: string;
  providers: RemoteModelCatalogOverlay;
  recommendations: Readonly<Record<string, readonly string[]>>;
  pricing: Readonly<Record<string, RemoteModelCatalogPrice>>;
  upstreamPricing: Readonly<Record<string, RemoteModelCatalogUpstreamPrice>>;
};

const STARTUP_SNAPSHOT_KEY = "openclaw.remoteModelCatalogStartupSnapshot";
const remoteCatalogScope = resolveGlobalSingleton(
  Symbol.for("openclaw.remoteModelCatalogScope"),
  () => new AsyncLocalStorage<{ catalog: ActiveRemoteModelCatalog | null }>(),
);

function isCompatible(bundle: RemoteModelCatalogWireBundle): boolean {
  if (!bundle.minVersion) {
    return true;
  }
  const comparison = compareOpenClawVersions(VERSION, bundle.minVersion);
  return comparison !== null && comparison >= 0;
}

function selectCompatibleRemoteModelCatalog(
  stored: Awaited<ReturnType<typeof readRemoteModelCatalogAsync>>,
  bundledGeneratedAt: number,
): ActiveRemoteModelCatalog | null {
  if (!stored) {
    return null;
  }
  const bundle = parseRemoteModelCatalogWireBundle(JSON.parse(stored.bundle_json));
  if (!isCompatible(bundle)) {
    return null;
  }
  const recommendations = Object.fromEntries(
    Object.entries(bundle.providers).map(([provider, catalog]) => [
      provider,
      catalog.recommendedModels ?? [],
    ]),
  );
  // Bundled rows and prices supersede older downloads, but do not contain the
  // hosted recommendations. Rank only currently served rows against those IDs.
  const overlay =
    bundle.generatedAt > bundledGeneratedAt
      ? projectRemoteModelCatalog(bundle)
      : { providers: {}, pricing: {}, upstreamPricing: {} };
  return freezeJsonSnapshot({
    sourceUrl: stored.source_url,
    generatedAt: bundle.generatedAt,
    revision: createHash("sha256").update(stored.bundle_json).digest("hex"),
    recommendations,
    ...overlay,
  });
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
  // Downloads are inert; workers inherit only the host's accepted rows/pricing pair.
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, { catalog: snapshot });
  return snapshot;
}

/** Read the already-published startup pair without loading persistent state. */
export function captureRemoteModelCatalogStartupSnapshot(): ActiveRemoteModelCatalog | null {
  return inheritedRemoteModelCatalogStartupSnapshot()?.catalog ?? null;
}

/** Prepare the same first-winner startup pair without host-thread SQLite reads. */
export async function prepareRemoteModelCatalogStartupSnapshot(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ActiveRemoteModelCatalog | null> {
  const inherited = inheritedRemoteModelCatalogStartupSnapshot();
  if (inherited !== undefined) {
    return inherited.catalog;
  }
  const bundledGeneratedAt = bundledCatalogGeneratedAt();
  if (bundledGeneratedAt === undefined) {
    return publishRemoteModelCatalogStartupSnapshot(null);
  }
  const context = captureOpenClawStateWorkerContext(options);
  let snapshot: ActiveRemoteModelCatalog | null;
  try {
    snapshot = selectCompatibleRemoteModelCatalog(
      await readRemoteModelCatalogAsync(context),
      bundledGeneratedAt,
    );
  } catch {
    snapshot = null;
  }
  // Optional read/parse failures are absence; retired work cannot publish that absence.
  context.admission.assertCurrent();
  return publishRemoteModelCatalogStartupSnapshot(snapshot);
}

/** Capture the accepted pair, including absence, for a build, worker task, or run. */
export function captureRemoteModelCatalogSnapshot(): ActiveRemoteModelCatalog | null {
  const scoped = remoteCatalogScope.getStore();
  return scoped === undefined ? captureRemoteModelCatalogStartupSnapshot() : scoped.catalog;
}

export function withRemoteModelCatalogSnapshot<T>(
  catalog: ActiveRemoteModelCatalog | null,
  run: () => T,
): T {
  return remoteCatalogScope.run({ catalog }, run);
}

/** Detached admissions select the current pair, not their caller's retained pair. */
export function runOutsideRemoteModelCatalogSnapshot<T>(run: () => T): T {
  return remoteCatalogScope.exit(run);
}

async function readStoredRemoteModelCatalog(
  config: OpenClawConfig,
): Promise<{ snapshot: ActiveRemoteModelCatalog; bundledGeneratedAt: number } | undefined> {
  if (!isRemoteModelCatalogRefreshEnabled(config)) {
    return undefined;
  }
  const bundledGeneratedAt = bundledCatalogGeneratedAt();
  if (bundledGeneratedAt === undefined) {
    return undefined;
  }
  const context = captureOpenClawStateWorkerContext();
  const snapshot = selectCompatibleRemoteModelCatalog(
    await readRemoteModelCatalogAsync(context),
    bundledGeneratedAt,
  );
  context.admission.assertCurrent();
  return snapshot && isRemoteCatalogSourceActive(config, snapshot.sourceUrl)
    ? { snapshot, bundledGeneratedAt }
    : undefined;
}

/** Preparation does not change the pair visible to current readers. */
export async function readRemoteModelCatalogUpdate(
  config: OpenClawConfig,
): Promise<ActiveRemoteModelCatalog | undefined> {
  const stored = await readStoredRemoteModelCatalog(config);
  return stored && stored.snapshot.generatedAt > stored.bundledGeneratedAt
    ? stored.snapshot
    : undefined;
}

/** Stored recommendations stay valid when the catalog is older than this build. */
export async function readRemoteModelCatalogProviderRecommendations(
  config: OpenClawConfig,
  provider: string,
): Promise<readonly string[] | undefined> {
  return (await readStoredRemoteModelCatalog(config))?.snapshot.recommendations[
    normalizeProviderId(provider)
  ];
}

/** The prepared catalog owner commits this pair in the same turn as its rows. */
export function publishRemoteModelCatalogSnapshot(
  catalog: ActiveRemoteModelCatalog,
  previous: ActiveRemoteModelCatalog | null,
): boolean {
  if (captureRemoteModelCatalogStartupSnapshot() !== previous) {
    return false;
  }
  setEnvironmentData(STARTUP_SNAPSHOT_KEY, { catalog });
  return true;
}

export function getActiveRemoteModelCatalog(
  config: OpenClawConfig,
): ActiveRemoteModelCatalog | undefined {
  if (!isRemoteModelCatalogRefreshEnabled(config)) {
    return undefined;
  }
  const scoped = remoteCatalogScope.getStore();
  const snapshot =
    scoped !== undefined ? scoped.catalog : captureRemoteModelCatalogStartupSnapshot();
  return snapshot && isRemoteCatalogSourceActive(config, snapshot.sourceUrl) ? snapshot : undefined;
}

export function getRemoteModelCatalogProviderOverlay(
  config: OpenClawConfig,
  provider: string,
): ModelCatalogProvider | undefined {
  const providerId = normalizeProviderId(provider);
  return providerId ? getActiveRemoteModelCatalog(config)?.providers[providerId] : undefined;
}

export function getRemoteModelCatalogProviderRecommendations(
  config: OpenClawConfig,
  provider: string,
): readonly string[] | undefined {
  const providerId = normalizeProviderId(provider);
  return providerId ? getActiveRemoteModelCatalog(config)?.recommendations[providerId] : undefined;
}
