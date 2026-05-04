import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDoctorHealthContributions,
  shouldSkipLegacyUpdateDoctorConfigWrite,
} from "./doctor-health-contributions.js";

const mocks = vi.hoisted(() => ({
  getModelRefStatus: vi.fn(),
  loadModelCatalog: vi.fn(),
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  note: vi.fn(),
  resolveConfiguredModelRef: vi.fn(),
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_MODEL: "gpt-5.5",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () => ({
  getModelRefStatus: mocks.getModelRefStatus,
  resolveConfiguredModelRef: mocks.resolveConfiguredModelRef,
}));

vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () => ({
  maybeRunConfiguredPluginInstallReleaseStep: mocks.maybeRunConfiguredPluginInstallReleaseStep,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../version.js", () => ({
  VERSION: "2026.5.2-test",
}));

describe("doctor health contributions", () => {
  beforeEach(() => {
    mocks.getModelRefStatus.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockReset();
    mocks.note.mockReset();
    mocks.resolveConfiguredModelRef.mockReset();
    mocks.resolveConfiguredModelRef.mockReturnValue({ provider: "openai", model: "gpt-5.5" });
  });

  it("runs release configured plugin install repair before plugin registry and final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("keeps release configured plugin installs repair-only", async () => {
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:release-configured-plugin-installs",
    );
    expect(contribution).toBeDefined();
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: { shouldRepair: false },
      env: {},
    } as Parameters<NonNullable<typeof contribution>["run"]>[0];

    await contribution?.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:release-configured-plugin-installs",
    );
    expect(contribution).toBeDefined();
    const ctx = {
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: { shouldRepair: true },
      env: {},
    } as Parameters<NonNullable<typeof contribution>["run"]>[0];

    await contribution?.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).toHaveBeenCalledWith({
      cfg: {},
      env: {},
      touchedVersion: "2026.4.29",
    });
    expect(mocks.note).toHaveBeenCalledWith(
      "Installed configured plugin matrix.",
      "Doctor changes",
    );
    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.2-test");
  });

  it("checks command owner configuration before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:command-owner")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:command-owner")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("checks skill readiness before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:skills")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:skills")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });

  it("skips model allowlist catalog checks when no allowlist is configured", async () => {
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:model-allowlist-catalog",
    );
    expect(contribution).toBeDefined();

    await contribution?.run(makeHealthContext({}));

    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("warns when provider-supplied catalog rows are hidden by the model allowlist", async () => {
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:model-allowlist-catalog",
    );
    expect(contribution).toBeDefined();
    mocks.loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        catalogSource: "provider-supplemental",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.5",
        name: "GPT-5.5 Codex",
        catalogSource: "provider-supplemental",
      },
    ]);
    mocks.getModelRefStatus.mockImplementation(({ ref }) => ({
      key: `${ref.provider}/${ref.model}`,
      inCatalog: true,
      allowAny: false,
      allowed: ref.provider === "openai" && ref.model === "gpt-5.4",
    }));

    await contribution?.run(
      makeHealthContext({
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {},
            },
          },
        },
      } as OpenClawConfig),
    );

    expect(mocks.note).toHaveBeenCalledTimes(1);
    const message = String(mocks.note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("2 provider-supplied catalog models are available");
    expect(message).toContain("openai/gpt-5.5");
    expect(message).toContain("openai-codex/gpt-5.5");
    expect(message).toContain(
      `openclaw config set agents.defaults.models '{"openai/gpt-5.5":{}}' --strict-json --merge`,
    );
  });

  it("skips doctor config writes under legacy update parents", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      }),
    ).toBe(true);
  });

  it("keeps doctor writes outside legacy update writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {},
      }),
    ).toBe(false);
  });

  it("keeps current update parents writable", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
      }),
    ).toBe(false);
  });

  it("treats falsey update env values as normal writes", () => {
    expect(
      shouldSkipLegacyUpdateDoctorConfigWrite({
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
        },
      }),
    ).toBe(false);
  });
});

function makeHealthContext(cfg: OpenClawConfig) {
  return {
    cfg,
    cfgForPersistence: cfg,
    configPath: "/tmp/openclaw.json",
    configResult: { cfg },
    env: {},
    options: {},
    prompter: { shouldRepair: false },
    runtime: {},
    sourceConfigValid: true,
  } as Parameters<ReturnType<typeof resolveDoctorHealthContributions>[number]["run"]>[0];
}
