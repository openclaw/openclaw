import { onTestFinished } from "vitest";
import { createGitHubRepositorySource } from "../../../extensions/github-repositories/repository-source-api.js";
import { readRuntimeConfig } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { performRepositoryCheckout } from "../../plugins/repository-checkout-transfer.js";
import { createRepositorySourceFixture } from "../../plugins/repository-source.test-support.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createRepositorySources } from "../repository-sources.js";
import type { GatewayRequestContext } from "../server-methods/types.js";

/** Real source admission and lifetime wrappers; individual suites substitute only transport I/O. */
export function createRepositorySourcesFixture(
  getConfig: () => OpenClawConfig = readRuntimeConfig,
) {
  const lifetime = new AbortController();
  const fixture = createRepositorySourceFixture(
    createGitHubRepositorySource(getConfig, async () => {}),
  );
  const sources = createRepositorySources(lifetime.signal, fixture.registry);
  onTestFinished(() => lifetime.abort());
  return sources;
}

/** A local Git transport substitutes I/O for this admitted synthetic remote source. */
export function createLocalRepositorySourcesFixture(repositoryUrl?: string) {
  const lifetime = new AbortController();
  const unsupported = async (): Promise<never> => {
    throw new Error("Local fixture supports checkout only");
  };
  const fixture = createRepositorySourceFixture({
    id: "local",
    resolve(url) {
      return url === repositoryUrl || url.startsWith("https://repository-fixture.test/")
        ? { url, name: "local fixture" }
        : undefined;
    },
    prepare: unsupported,
    worker: {
      isIdentityCurrent: ({ identityKey }) => identityKey === "local-fixture",
      prepare: unsupported,
      async checkout({ transfer, assertCurrent }) {
        await performRepositoryCheckout(transfer, {
          assertCurrent,
          start: async (run) => await run(),
        });
      },
    },
  });
  const sources = createRepositorySources(lifetime.signal, fixture.registry);
  onTestFinished(() => lifetime.abort());
  return sources;
}

/** Supported invocation binding for direct source caller tests, not authenticated-server proof. */
export function withRepositorySourceGatewayFixture<T>(
  getConfig: () => OpenClawConfig,
  run: (sources: ReturnType<typeof createRepositorySourcesFixture>) => Promise<T>,
): Promise<T> {
  const sources = createRepositorySourcesFixture(getConfig);
  const context = {
    getRuntimeConfig: getConfig,
    repositorySources: sources,
  } as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  const resources = new LegacyPluginSdkResourceHost();
  bindLegacyPluginSdkResourceHost(context.resolveGatewayContext, resources);
  onTestFinished(() => resources.close());
  return withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () => run(sources));
}
