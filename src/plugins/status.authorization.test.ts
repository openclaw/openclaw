// Covers authorization-policy status inspection for runtime and metadata reports.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginLoadResult, createPluginRecord } from "./status.test-fixtures.js";

const statusMocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn(),
  loadPluginMetadataRegistrySnapshot: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => statusMocks.loadOpenClawPlugins(...args),
}));

vi.mock("./runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    statusMocks.loadPluginMetadataRegistrySnapshot(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) =>
    statusMocks.loadPluginMetadataSnapshot(...args),
}));

vi.mock("./runtime/load-context.js", () => ({
  resolvePluginRuntimeLoadContext: (params?: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
  }) => {
    const config = params?.config ?? {};
    return {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: params?.workspaceDir ?? "/workspace",
      env: params?.env ?? process.env,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    };
  },
  buildPluginRuntimeLoadOptions: (_context: unknown, options: unknown) => options,
}));

vi.mock("./providers.js", () => ({
  resolveBundledProviderCompatPluginIds: () => [],
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: ({ config }: { config: OpenClawConfig }) => config,
}));

vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  listImportedBundledPluginFacadeIds: () => [],
}));

vi.mock("./runtime.js", () => ({
  listImportedRuntimePluginIds: () => [],
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => undefined,
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/workspace",
}));

let buildPluginDiagnosticsReport: typeof import("./status.js").buildPluginDiagnosticsReport;
let buildPluginInspectReport: typeof import("./status.js").buildPluginInspectReport;
let buildPluginSnapshotReport: typeof import("./status.js").buildPluginSnapshotReport;

function expectInspectReport(
  pluginId: string,
  options: Omit<Parameters<typeof buildPluginInspectReport>[0], "id"> = {},
): NonNullable<ReturnType<typeof buildPluginInspectReport>> {
  const inspect = buildPluginInspectReport({ id: pluginId, ...options });
  if (inspect === null) {
    throw new Error(`expected inspect report for ${pluginId}`);
  }
  return inspect;
}

describe("plugin authorization status reports", () => {
  beforeAll(async () => {
    ({ buildPluginDiagnosticsReport, buildPluginInspectReport, buildPluginSnapshotReport } =
      await import("./status.js"));
  });

  beforeEach(() => {
    const emptyRegistry = createPluginLoadResult({ plugins: [] });
    statusMocks.loadOpenClawPlugins.mockReset().mockReturnValue(emptyRegistry);
    statusMocks.loadPluginMetadataRegistrySnapshot.mockReset().mockReturnValue(emptyRegistry);
    statusMocks.loadPluginMetadataSnapshot.mockReset().mockReturnValue({
      index: {},
      manifestRegistry: { plugins: [], diagnostics: [] },
      plugins: [],
      byPluginId: new Map(),
    });
  });

  it("reports sanitized runtime authorization policy coverage", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          guard: {
            authorization: {
              requiredPolicies: [
                { id: "ready", operations: ["tool.call"] },
                {
                  id: "partial",
                  operations: ["tool.call", "message.action", "command.invoke"],
                },
                { id: "absent", operations: ["command.invoke"] },
              ],
            },
          },
        },
      },
    };
    statusMocks.loadOpenClawPlugins.mockReturnValue(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "guard",
            contracts: { authorizationPolicies: ["partial", "ready", "partial"] },
          }),
        ],
        authorizationPolicies: [
          {
            pluginId: "guard",
            source: "/tmp/guard/index.ts",
            policy: {
              id: "ready",
              description: "do not expose this description",
              handlers: { "tool.call": () => ({ effect: "pass" }) },
            },
          },
          {
            pluginId: "guard",
            source: "/tmp/guard/index.ts",
            policy: {
              id: "partial",
              description: "also private",
              handlers: { "tool.call": () => ({ effect: "pass" }) },
            },
          },
        ],
      }),
    );
    const report = buildPluginDiagnosticsReport({ config, workspaceDir: "/workspace" });

    const inspect = expectInspectReport("guard", { config, report });

    expect(inspect.authorizationPolicies).toEqual({
      inspection: "runtime",
      declaredPolicyIds: ["partial", "ready"],
      registeredPolicies: [
        { id: "partial", operations: ["tool.call"] },
        { id: "ready", operations: ["tool.call"] },
      ],
      requiredPolicies: [
        {
          id: "ready",
          operations: ["tool.call"],
          status: "ready",
          missingOperations: [],
        },
        {
          id: "partial",
          operations: ["tool.call", "message.action", "command.invoke"],
          status: "missing-handler",
          missingOperations: ["message.action", "command.invoke"],
        },
        {
          id: "absent",
          operations: ["command.invoke"],
          status: "missing-registration",
          missingOperations: ["command.invoke"],
        },
      ],
    });
    expect(JSON.stringify(inspect.authorizationPolicies)).not.toContain("description");
    expect(JSON.stringify(inspect.authorizationPolicies)).not.toContain("/tmp/guard");
  });

  it("does not report missing registrations from metadata-only inspection", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          guard: {
            authorization: {
              requiredPolicies: [
                { id: "maintainer-access", operations: ["tool.call", "command.invoke"] },
              ],
            },
          },
        },
      },
    };
    const plugin = createPluginRecord({
      id: "guard",
      contracts: { authorizationPolicies: ["maintainer-access"] },
    });
    statusMocks.loadPluginMetadataRegistrySnapshot.mockReturnValue(
      createPluginLoadResult({ plugins: [plugin] }),
    );
    const report = buildPluginSnapshotReport({ config, workspaceDir: "/workspace" });

    const inspect = expectInspectReport("guard", { config, report });

    expect(inspect.authorizationPolicies).toEqual({
      inspection: "metadata",
      declaredPolicyIds: ["maintainer-access"],
      registeredPolicies: [],
      requiredPolicies: [
        {
          id: "maintainer-access",
          operations: ["tool.call", "command.invoke"],
          status: "not-runtime-inspected",
          missingOperations: [],
        },
      ],
    });
  });
});
