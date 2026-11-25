import type { PluginRegistry } from "./registry-types.js";
import { normalizePluginRepositoryUrl } from "./repository-source-url.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRegistryForContext } from "./runtime/gateway-request-scope.js";
export { normalizePluginRepositoryUrl } from "./repository-source-url.js";

const SourceId = /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/u;

/** Explicit selection never falls through to another plugin or the native source. */
export function resolvePluginRepositorySource(
  sourceId: string | undefined,
  url: string,
  registry: PluginRegistry | null | undefined = getPluginRegistryForContext() ??
    getActivePluginRegistry(),
  assertBoundCurrent: () => void = () => {},
) {
  assertBoundCurrent();
  if ((sourceId !== undefined && !SourceId.test(sourceId)) || !normalizePluginRepositoryUrl(url)) {
    throw new Error("Select a supported repository URL with its repository source.");
  }
  const matches = (registry?.repositorySources ?? []).flatMap((entry) => {
    const id = `${entry.pluginId}/${entry.provider.id}`;
    if (sourceId && id !== sourceId) {
      return [];
    }
    entry.assertCurrent();
    const resolved = entry.provider.resolve(url);
    return resolved && normalizePluginRepositoryUrl(resolved.url) ? [{ entry, resolved, id }] : [];
  });
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? "Several repository sources accept this URL. Select a source explicitly."
        : "The selected repository source is unavailable or does not accept this URL. Enable its plugin and retry.",
    );
  }
  const { entry, resolved, id } = matches[0]!;
  const resolvedUrl = resolved.url;
  const name = resolved.name;
  // Display changes appear on the next resolution; they never retire checkout authority.
  const display = resolved.display && {
    identity: resolved.display.identity,
    ...(resolved.display.host !== undefined ? { host: resolved.display.host } : {}),
  };
  entry.assertCurrent();
  const assertCurrent = () => {
    assertBoundCurrent();
    entry.assertCurrent();
    if (entry.provider.resolve(url)?.url !== resolvedUrl) {
      throw new Error("Repository source changed; select it again.");
    }
  };
  return {
    id,
    name,
    url: resolvedUrl,
    ...(display ? { display } : {}),
    assertCurrent,
    async prepare(input: Omit<Parameters<typeof entry.provider.prepare>[0], "url">) {
      const assertSourceCurrent = () => {
        assertCurrent();
        input.signal?.throwIfAborted();
        input.assertCurrent();
      };
      assertSourceCurrent();
      const prepared = await entry.provider.prepare({
        ...input,
        url: resolvedUrl,
        assertCurrent: assertSourceCurrent,
      });
      assertSourceCurrent();
      const assertPrepared = () => {
        assertSourceCurrent();
        prepared.assertCurrent();
      };
      assertPrepared();
      return {
        project: prepared.project,
        assertCurrent: assertPrepared,
        async resolveBase(ref?: string) {
          assertPrepared();
          const base = await prepared.resolveBase(ref);
          assertPrepared();
          if (
            typeof base?.commit !== "string" ||
            !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(base.commit) ||
            typeof base.ref !== "string" ||
            !base.ref ||
            /[\0\r\n]/u.test(base.ref)
          ) {
            throw new Error("Repository source returned an invalid base; reselect the repository.");
          }
          return base;
        },
      };
    },
  };
}
