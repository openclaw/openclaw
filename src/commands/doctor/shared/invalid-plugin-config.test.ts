// Invalid plugin config tests cover doctor diagnostics for malformed plugin configuration.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const validationMocks = vi.hoisted(() => ({
  validateConfigObjectWithPlugins: vi.fn(),
  findDoctorLegacyConfigIssues: vi.fn((): Array<{ path: string; message: string }> => []),
}));

vi.mock("../../../config/validation.js", () => ({
  validateConfigObjectWithPlugins: validationMocks.validateConfigObjectWithPlugins,
  validateConfigObjectRawWithPlugins: validationMocks.validateConfigObjectWithPlugins,
}));

vi.mock("./legacy-config-issues.js", () => ({
  findDoctorLegacyConfigIssues: validationMocks.findDoctorLegacyConfigIssues,
}));

const [{ maybeRepairInvalidPluginConfig }, { migrateLegacyConfig }] = await Promise.all([
  import("./invalid-plugin-config.js"),
  import("./legacy-config-migrate.js"),
]);

describe("doctor invalid plugin config repair", () => {
  beforeEach(() => {
    validationMocks.validateConfigObjectWithPlugins.mockReset();
    validationMocks.findDoctorLegacyConfigIssues.mockReset();
  });

  it.each(["pending", "other"])(
    "preserves only the plugin with a declared %s migration",
    (migrationOwner) => {
      validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
        ok: false,
        issues: [
          { path: "plugins.entries.pending.config", message: "invalid config: retired root" },
        ],
      });
      validationMocks.findDoctorLegacyConfigIssues.mockReturnValue([
        { path: `plugins.entries.${migrationOwner}.config.root`, message: "Run doctor --fix" },
      ]);
      const cfg: OpenClawConfig = {
        plugins: { entries: { pending: { enabled: true, config: { root: "/legacy/documents" } } } },
      };
      const result = maybeRepairInvalidPluginConfig(cfg);
      expect(result.config.plugins?.entries?.pending).toEqual(
        migrationOwner === "pending" ? cfg.plugins?.entries?.pending : { enabled: false },
      );
      expect(result.changes).toHaveLength(migrationOwner === "pending" ? 0 : 1);
    },
  );

  it("ignores non-plugin validation issues", () => {
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      warnings: [],
      issues: [
        {
          path: "gateway.mode",
          message: "Expected 'local' or 'remote'",
        },
      ],
    });
    const cfg = {
      gateway: {
        mode: "invalid",
      },
    } as unknown as OpenClawConfig;

    expect(maybeRepairInvalidPluginConfig(cfg)).toEqual({ config: cfg, changes: [] });
  });
});

describe("legacy migration with invalid plugin config", () => {
  beforeEach(() => {
    validationMocks.validateConfigObjectWithPlugins.mockReset();
  });

  it("keeps safe migrations when unrelated plugin validation issues remain (#76798)", () => {
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      warnings: [],
      issues: [
        {
          path: "plugins.entries.brave.config.webSearch.mode",
          message: "invalid config: must be equal to one of the allowed values",
        },
      ],
    });

    const raw = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
      session: { typingMode: "thinking" },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(result).toEqual({
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            typingMode: "thinking",
          },
        },
        session: {},
      },
      changes: [
        "Moved session.typingMode → agents.defaults.typingMode.",
        "Migration applied; other validation issues remain — run doctor to review.",
      ],
      partiallyValid: true,
    });
  });
});
