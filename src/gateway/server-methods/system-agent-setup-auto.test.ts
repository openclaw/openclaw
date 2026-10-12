import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SetupInferenceCandidate,
  SetupInferenceDetection,
} from "../../system-agent/setup-inference-core.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { SetupAdmissionBusyError } from "./setup-admission.js";
import { runGatewayAutomaticSetup } from "./system-agent-setup-auto.js";
import type { GatewayRequestContext } from "./types.js";

const fixture = vi.hoisted(() => ({
  detect: vi.fn<() => Promise<SetupInferenceDetection>>(),
  activate: vi.fn(),
  prepare: vi.fn(),
  readConfig: vi.fn(),
  commit: vi.fn(async ({ config }: { config: OpenClawConfig }) => config),
  audit: vi.fn(async () => {}),
}));

// mock-isolation: Discovery and provider activation must never use this host's credentials.
vi.mock("../../system-agent/setup-inference-detect.js", () => ({
  detectSetupInference: fixture.detect,
}));
// mock-isolation: Keep the real target admission lock, without starting provider subprocesses.
vi.mock("./system-agent-execution.js", () => ({
  createSystemAgentGatewayRuntime: () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
  runSystemAgentGatewayTask: async <T>(task: () => Promise<T>) => await task(),
  activateGatewaySetupInference: fixture.activate,
}));
// mock-isolation: Managed installation is an external effect owned by the Codex preparation tests.
vi.mock("../../system-agent/setup-inference-codex.js", () => ({
  prepareAutomaticSetupCodex: fixture.prepare,
}));
// mock-isolation: Config snapshots are fixed inputs; only the admission lock touches the filesystem.
vi.mock("../../config/config.js", () => ({ readConfigFileSnapshot: fixture.readConfig }));
// mock-isolation: Runtime config application is separately tested; observe its requested config here.
vi.mock("../../system-agent/setup-inference-transition.js", () => ({
  commitSetupInferenceActivation: fixture.commit,
  captureSetupInferenceFileUndo: vi.fn(),
  setupConfigPatchConflicts: vi.fn(),
}));
// mock-isolation: The mocked commit never invokes the production config writer.
vi.mock("../../plugins/install-record-commit.js", () => ({
  transformConfigWithPendingPluginInstalls: vi.fn(),
}));
// mock-isolation: Installed-plugin inventory is a fixture, not the developer's current install.
vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: () => ({ index: { plugins: [] } }),
}));
// mock-isolation: Use only shipped native-catalog declarations, without scanning host plugins.
vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({ plugins: [] }),
}));
// mock-isolation: Automatic setup must not append audit events to the operator's database.
vi.mock("../../system-agent/audit.js", () => ({ appendSystemAgentAuditEntry: fixture.audit }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const codex: SetupInferenceCandidate = {
  kind: "codex-cli",
  modelRef: "openai/model",
  label: "Codex",
  detail: "Stored credentials found",
  brandId: "openai",
  credentials: true,
  recommended: false,
};
const openai: SetupInferenceCandidate = {
  kind: "openai-api-key",
  modelRef: "openai/model",
  label: "OpenAI API key",
  detail: "OPENAI_API_KEY set",
  credentials: true,
  recommended: false,
};
const presentedCodex = {
  kind: "codex-cli",
  modelRef: "openai/model",
  label: "Codex",
  detail: "Stored credentials found",
  brandId: "openai",
};

function detection(
  candidates: SetupInferenceCandidate[] = [],
  overrides: Partial<SetupInferenceDetection> = {},
): SetupInferenceDetection {
  return {
    candidates,
    authOptions: [],
    manualProviders: [],
    recommendedInstalls: [],
    unavailableCandidates: [],
    workspace: "/fixture/workspace",
    setupComplete: false,
    ...overrides,
  };
}

function context(): GatewayRequestContext {
  return createWizardSessionTracker() as GatewayRequestContext;
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("setup-auto-admission-"));
  fixture.detect.mockResolvedValue(detection());
  fixture.activate.mockResolvedValue({
    ok: true,
    modelRef: codex.modelRef,
    latencyMs: 1,
    lines: [],
  });
  fixture.readConfig.mockResolvedValue({ config: {}, runtimeConfig: {}, sourceConfig: {} });
  fixture.prepare.mockResolvedValue({ error: "Could not install the official Codex plugin." });
  fixture.audit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Gateway automatic inference setup", () => {
  it("returns an existing model and ranked alternatives without starting a write", async () => {
    const current: SetupInferenceCandidate = {
      ...codex,
      kind: "existing-model",
      label: "Current model",
    };
    fixture.detect.mockResolvedValue(detection([openai, current, codex], { setupComplete: true }));

    expect(await runGatewayAutomaticSetup(context())).toEqual({
      status: "configured",
      selected: { ...presentedCodex, kind: "existing-model", label: "Current model" },
      alternatives: [
        presentedCodex,
        {
          kind: openai.kind,
          modelRef: openai.modelRef,
          label: openai.label,
          detail: openai.detail,
        },
      ],
      attempts: [],
      installedPlugins: [],
    });
    expect(fixture.readConfig).not.toHaveBeenCalled();
    expect(fixture.activate).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it("records a failed saved sign-in and activates the next ranked route", async () => {
    const saved: SetupInferenceCandidate = {
      ...openai,
      kind: "saved-auth:expired",
      label: "Saved sign-in",
    };
    fixture.detect.mockResolvedValue(detection([openai, codex, saved]));
    fixture.activate.mockResolvedValueOnce({
      ok: false,
      status: "auth",
      error: "Saved sign-in expired.",
    });

    expect(await runGatewayAutomaticSetup(context())).toEqual({
      status: "activated",
      selected: presentedCodex,
      alternatives: [
        {
          kind: openai.kind,
          modelRef: openai.modelRef,
          label: openai.label,
          detail: openai.detail,
        },
      ],
      attempts: [{ kind: saved.kind, label: saved.label, error: "Saved sign-in expired." }],
      installedPlugins: ["codex"],
    });
    expect(fixture.activate.mock.calls.map(([params]) => params.kind)).toEqual([
      saved.kind,
      "codex-cli",
    ]);
    expect(fixture.activate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "codex-cli",
        automaticSetup: true,
        activationConfirmed: true,
        nativeSessionCatalogsEnabled: false,
      }),
    );
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("limits activation to four attempts even after Codex preparation discovers credentials", async () => {
    const candidates: SetupInferenceCandidate[] = [];
    for (const id of ["e", "d", "c", "b", "a"]) {
      candidates.push({ ...openai, kind: `saved-auth:${id}`, label: `Saved ${id}` });
    }
    fixture.detect
      .mockResolvedValueOnce(detection(candidates))
      .mockResolvedValueOnce(detection([codex]));
    fixture.activate.mockResolvedValue({ ok: false, status: "auth", error: "Sign-in expired." });
    fixture.prepare.mockResolvedValue({ ok: true, config: {} });

    expect(await runGatewayAutomaticSetup(context())).toEqual({
      status: "unavailable",
      alternatives: [],
      attempts: [
        ...["a", "b", "c"].map((id) => ({
          kind: `saved-auth:${id}`,
          label: `Saved ${id}`,
          error: "Sign-in expired.",
        })),
        { kind: "codex-cli", label: "Codex", error: "Sign-in expired." },
      ],
      installedPlugins: ["codex"],
    });
    expect(fixture.activate).toHaveBeenCalledTimes(4);
    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  it("joins concurrent callers before activation and holds admission against an independent context", async () => {
    const started = createDeferred();
    const discovered = createDeferred<SetupInferenceDetection>();
    fixture.detect.mockImplementationOnce(() => {
      started.resolve();
      return discovered.promise;
    });
    const gateway = context();
    const first = runGatewayAutomaticSetup(gateway);
    try {
      await awaitGateBeforeSettlement(
        started.promise,
        first,
        "automatic setup ended before discovery",
      );
      const joined = runGatewayAutomaticSetup(gateway);
      expect(joined).toBe(first);
      await expect(runGatewayAutomaticSetup(context())).rejects.toBeInstanceOf(
        SetupAdmissionBusyError,
      );
      expect(fixture.detect).toHaveBeenCalledOnce();
      expect(fixture.activate).not.toHaveBeenCalled();
      discovered.resolve(detection([codex]));
      expect(await joined).toMatchObject({ status: "activated", selected: presentedCodex });
      expect(fixture.activate).toHaveBeenCalledOnce();
    } finally {
      discovered.resolve(detection());
      await first;
    }
  });

  it.each([false, true])(
    "prepares Codex and returns sign-in despite audit failure: %s",
    async (auditFails) => {
      if (auditFails) {
        fixture.audit.mockRejectedValueOnce(new Error("audit store unavailable"));
      }
      const prepared: OpenClawConfig = { plugins: { entries: { codex: { enabled: true } } } };
      fixture.prepare.mockResolvedValue({ ok: true, config: prepared });
      fixture.detect.mockResolvedValueOnce(detection()).mockResolvedValueOnce(
        detection([], {
          authOptions: [
            {
              id: "openai-codex",
              brandId: "openai",
              label: "ChatGPT",
              kind: "oauth",
              featured: true,
            },
          ],
        }),
      );

      expect(await runGatewayAutomaticSetup(context())).toEqual({
        status: "needs-sign-in",
        alternatives: [],
        attempts: [],
        installedPlugins: ["codex"],
        signIn: { authOptionId: "openai-codex", label: "ChatGPT" },
      });
      expect(fixture.activate).not.toHaveBeenCalled();
      expect(fixture.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          preserveWorkingConnection: true,
          config: {
            plugins: {
              entries: {
                codex: { enabled: true, config: { sessionCatalog: { enabled: false } } },
                anthropic: { config: { sessionCatalog: { enabled: false } } },
              },
            },
          },
        }),
      );
    },
  );
});
