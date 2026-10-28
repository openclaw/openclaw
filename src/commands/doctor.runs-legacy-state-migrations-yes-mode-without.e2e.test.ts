import { beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  arrangeLegacyStateMigrationTest,
  confirm,
  createDoctorRuntime,
  ensureAuthProfileStore,
  mockDoctorConfigSnapshot,
  transformConfigFile,
} from "./doctor.e2e-harness.js";
import { loadDoctorCommandForTest } from "./doctor.note-test-helpers.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  useMockProviders: false,
  resolvePluginProvidersCore: vi.fn((_params?: unknown): ProviderPlugin[] => []),
}));

vi.mock("../plugins/providers.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/providers.runtime.js")>(
    "../plugins/providers.runtime.js",
  );
  return {
    ...actual,
    resolvePluginProvidersCore: (
      params: Parameters<typeof actual.resolvePluginProvidersCore>[0],
    ): ProviderPlugin[] =>
      providerRuntimeMocks.useMockProviders
        ? providerRuntimeMocks.resolvePluginProvidersCore(params)
        : actual.resolvePluginProvidersCore(params),
  };
});

let doctorCommand: typeof import("./doctor.js").doctorCommand;

async function expectNixRefusal(options: Parameters<typeof doctorCommand>[1]) {
  mockDoctorConfigSnapshot();
  await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
    await expect(doctorCommand(createDoctorRuntime(), options)).rejects.toThrow(
      "OPENCLAW_NIX_MODE=1",
    );
  });
  expect(transformConfigFile).not.toHaveBeenCalled();
}

beforeEach(async () => {
  doctorCommand = await loadDoctorCommandForTest({
    unmockModules: ["../flows/doctor-health-contributions.js"],
  });
  vi.clearAllMocks();
  providerRuntimeMocks.useMockProviders = false;
  providerRuntimeMocks.resolvePluginProvidersCore.mockReturnValue([]);
});

it("runs legacy state migrations in yes mode without prompting", async () => {
  const {
    doctorCommand: runDoctor,
    runtime,
    runLegacyStateMigrations,
  } = await arrangeLegacyStateMigrationTest();
  await (runDoctor as (runtime: unknown, opts: Record<string, unknown>) => Promise<void>)(runtime, {
    yes: true,
  });
  expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
}, 30_000);

it.each([{ repair: true }, { generateGatewayToken: true }])(
  "refuses Nix mutations before side effects: %j",
  expectNixRefusal,
);

it("migrates anthropic oauth config profile id when only email profile exists", async () => {
  mockDoctorConfigSnapshot({
    config: {
      auth: {
        profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } },
        order: { anthropic: ["anthropic:default"] },
      },
    },
  });

  ensureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: {
      "anthropic:me@example.com": {
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
        email: "me@example.com",
      },
    },
  });
  providerRuntimeMocks.useMockProviders = true;
  providerRuntimeMocks.resolvePluginProvidersCore.mockReturnValue([
    {
      id: "anthropic",
      label: "Anthropic",
      auth: [],
      oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
    },
  ]);

  await withEnvAsync({ OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" }, () =>
    doctorCommand(createDoctorRuntime(), { yes: true }),
  );

  const committed = await Promise.all(
    transformConfigFile.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value] : [],
    ),
  );
  const auth = committed.findLast((result) => result.nextConfig.auth?.profiles)?.nextConfig.auth;
  expect(auth).toMatchObject({
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
    },
    order: { anthropic: ["anthropic:me@example.com"] },
  });
  expect(auth?.profiles).not.toHaveProperty("anthropic:default");
}, 30_000);
