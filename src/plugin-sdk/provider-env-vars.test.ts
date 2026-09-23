import { getProviderEnvVars as getImageProviderEnvVars } from "openclaw/plugin-sdk/image-generation-core";
import { listKnownProviderAuthEnvVarNames as listAuthEnvVarNames } from "openclaw/plugin-sdk/provider-auth";
import {
  getProviderEnvVars,
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEnvVarCandidates,
} from "openclaw/plugin-sdk/provider-env-vars";
import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

type LookupParams = NonNullable<Parameters<typeof listKnownProviderAuthEnvVarNames>[0]>;
const readers = [
  {
    name: "provider-env-vars/getProviderEnvVars",
    read: (params: LookupParams) => getProviderEnvVars("compat-provider", params),
    expected: ["COMPAT_PROVIDER_KEY"],
  },
  {
    name: "image-generation-core/getProviderEnvVars",
    read: (params: LookupParams) => getImageProviderEnvVars("compat-provider", params),
    expected: ["COMPAT_PROVIDER_KEY"],
  },
  {
    name: "provider-env-vars/resolveProviderAuthEnvVarCandidates",
    read: (params: LookupParams) =>
      resolveProviderAuthEnvVarCandidates(params)["compat-provider"] ?? [],
    expected: ["COMPAT_PROVIDER_KEY"],
  },
  {
    name: "provider-env-vars/listKnownProviderAuthEnvVarNames",
    read: listKnownProviderAuthEnvVarNames,
    expected: ["COMPAT_PROVIDER_KEY", "COMPAT_USAGE_KEY"],
  },
  {
    name: "provider-auth/listKnownProviderAuthEnvVarNames",
    read: listAuthEnvVarNames,
    expected: ["COMPAT_PROVIDER_KEY", "COMPAT_USAGE_KEY"],
  },
];

describe.each(["current", "v2026.9.4"])("provider environment SDK with %s snapshots", (version) => {
  it.each(readers)(
    "preserves manifest names and trust filtering through $name",
    ({ read, expected }) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "compat-provider",
            origin: "workspace",
            setup: { providers: [{ id: "compat-provider", envVars: ["COMPAT_PROVIDER_KEY"] }] },
            providerUsageAuthEnvVars: { "compat-provider": ["COMPAT_USAGE_KEY"] },
          },
        ],
      });
      const { providerAuthContributions: _contributions, ...releasedOwners } = snapshot.owners;
      const metadataSnapshot =
        version === "current" ? snapshot : { ...snapshot, owners: Object.freeze(releasedOwners) };
      const params = { metadataSnapshot } satisfies LookupParams;

      expect(read(params)).toEqual(expect.arrayContaining(expected));
      const untrustedNames = read({
        ...params,
        config: {},
        includeUntrustedWorkspacePlugins: false,
      });
      expect(untrustedNames).not.toContain("COMPAT_PROVIDER_KEY");
      expect(untrustedNames).not.toContain("COMPAT_USAGE_KEY");
    },
  );
});
