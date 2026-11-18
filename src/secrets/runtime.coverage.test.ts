/** Remaining credential paths not covered by the dedicated runtime owner suites. */
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { resolveSecretRefValues } from "./resolve.js";

const contracts = vi.hoisted(() => new Map<string, object>());
vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => ({}),
}));
// mock-isolation: collector fixtures use explicit channel contracts without loading plugin runtimes.
vi.mock("./channel-contract-api.js", () => ({
  loadChannelSecretContractApi: ({ channelId }: { channelId: string }) => contracts.get(channelId),
}));

let applyResolvedAssignments: typeof import("./runtime-shared.js").applyResolvedAssignments;
let collectConfigAssignments: typeof import("./runtime-config-collectors.js").collectConfigAssignments;
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
const savedEnv = (
  [
    ["OPENCLAW_BUNDLED_PLUGINS_DIR", "extensions"],
    ["OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1"],
  ] as const
).map(([key, fallback]) => {
  const previous = process.env[key];
  process.env[key] ??= fallback;
  return { key, previous };
});
afterAll(() => {
  for (const { key, previous } of savedEnv) {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});
beforeAll(async () => {
  await Promise.all([
    import("./runtime-shared.js").then((runtime) => {
      ({ applyResolvedAssignments, createResolverContext } = runtime);
    }),
    import("./runtime-config-collectors.js").then((runtime) => {
      ({ collectConfigAssignments } = runtime);
    }),
    loadBundledPluginFacade<object>({
      pluginId: "mattermost",
      artifactBasename: "secret-contract-api.js",
    }).then((contract) => {
      contracts.set("mattermost", contract);
    }),
  ]);
});

const cases: Array<[string, string[], Record<string, unknown>]> = [
  [
    "models.providers.sample.request",
    [
      "headers.sample",
      "tls.ca",
      "tls.cert",
      "tls.key",
      "tls.passphrase",
      "proxy.tls.ca",
      "proxy.tls.cert",
      "proxy.tls.key",
      "proxy.tls.passphrase",
    ],
    {
      "models.providers.sample.baseUrl": "https://api.example/v1",
      "models.providers.sample.models": [],
      "models.providers.sample.request.proxy.mode": "explicit-proxy",
      "models.providers.sample.request.proxy.url": "http://proxy.example:8080",
    },
  ],
  ["channels.mattermost.accounts.sample", ["botToken"], {}],
  ["plugins.entries.typesafe.config", ["apiKey"], { "plugins.entries.typesafe.enabled": true }],
  ["gateway.auth", ["password"], { "gateway.auth.mode": "password" }],
  [
    "gateway.remote",
    ["token"],
    {
      "gateway.mode": "remote",
      "gateway.remote.url": "wss://gateway.example",
    },
  ],
];

test.each(cases)(
  "materializes %s credentials",
  async (prefix, fields, setup) => {
    const config: OpenClawConfig = {};
    const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_TEST_HOME };
    for (const [field, value] of Object.entries(setup)) {
      setPathCreateStrict(config, field.split("."), value);
    }
    for (const [index, field] of fields.entries()) {
      const id = `CREDENTIAL_${index}`;
      env[id] = `resolved-${field}`;
      setPathCreateStrict(config, `${prefix}.${field}`.split("."), {
        source: "env",
        provider: "default",
        id,
      });
    }
    const resolvedConfig = structuredClone(config);
    const context = createResolverContext({ sourceConfig: config, env });
    await collectConfigAssignments({
      config: resolvedConfig,
      context,
      loadablePluginOrigins: prefix.startsWith("plugins.")
        ? new Map([["typesafe", "bundled" as const]])
        : undefined,
    });
    const resolved = await resolveSecretRefValues(
      context.assignments.map(({ ref }) => ref),
      {
        config,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });
    for (const field of fields) {
      expect(getPath(resolvedConfig, `${prefix}.${field}`.split("."))).toBe(`resolved-${field}`);
    }
  },
  240_000,
);
