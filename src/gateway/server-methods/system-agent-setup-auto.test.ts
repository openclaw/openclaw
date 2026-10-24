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
const presentedCodex = {
  kind: "codex-cli" as const,
  modelRef: "openai/model",
  label: "Codex",
  detail: "Stored credentials found",
  brandId: "openai",
};
const presentedOpenai = {
  kind: "openai-api-key" as const,
  modelRef: "openai/model",
  label: "OpenAI API key",
  detail: "OPENAI_API_KEY set",
};
const codex: SetupInferenceCandidate = { ...presentedCodex, credentials: true, recommended: false };
const openai: SetupInferenceCandidate = {
  ...presentedOpenai,
  credentials: true,
  recommended: false,
};
const ollama: SetupInferenceCandidate = {
  kind: "provider-auto:ollama-local",
  modelRef: "ollama/fixture",
  label: "Ollama",
  detail: "Available locally",
  credentials: true,
  recommended: false,
};

const chatGptSignIn = {
  id: "openai-device-code",
  brandId: "openai",
  label: "ChatGPT",
  kind: "device-code" as const,
  featured: true,
};
const separateSignIn = { authOptionId: chatGptSignIn.id, label: chatGptSignIn.label };

function detection(
  candidates: SetupInferenceCandidate[] = [],
  overrides: Partial<SetupInferenceDetection> = {},
): SetupInferenceDetection {
  return {
    candidates,
    authOptions: [chatGptSignIn],
    manualProviders: [],
    recommendedInstalls: [],
    unavailableCandidates: [],
    workspace: "/fixture/workspace",
    setupComplete: false,
    ...overrides,
  };
}

function expectUnused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const runSetup = () => runGatewayAutomaticSetup(context(), () => {});

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
  it("surfaces detection errors before choosing or preparing any inference route", async () => {
    fixture.detect.mockRejectedValueOnce(new Error("Codex detection failed: permission denied"));

    await expect(runSetup()).rejects.toThrow("Codex detection failed: permission denied");
    expectUnused(fixture.activate, fixture.prepare, fixture.commit);
  });

  it.each(["unavailable", "unknown", "timeout", "throw"] as const)(
    "shows Codex inspection failure without activating Ollama: %s",
    async (failureMode) => {
      fixture.detect.mockResolvedValueOnce(detection([ollama, codex]));
      const error = "Cannot inspect Codex processes. Check process inspection permissions.";
      if (failureMode === "throw") {
        fixture.activate.mockRejectedValueOnce(new Error(error));
      } else {
        fixture.activate.mockResolvedValueOnce({ ok: false, status: failureMode, error });
      }

      expect(await runSetup()).toMatchObject({
        status: "unavailable",
        attempts: [{ kind: "codex-cli", label: "Codex", error }],
        alternatives: [{ kind: ollama.kind, modelRef: ollama.modelRef }],
      });
      expect(fixture.activate).toHaveBeenCalledOnce();
      expect(fixture.activate).toHaveBeenCalledWith(expect.objectContaining({ kind: "codex-cli" }));
      expectUnused(fixture.prepare, fixture.commit);
    },
  );

  it.each(["rate_limit", "billing", "format", "timeout", "unknown"] as const)(
    "can select Ollama after an ordinary Codex model failure: %s",
    async (status) => {
      fixture.detect.mockResolvedValueOnce(detection([ollama, codex]));
      fixture.activate
        .mockResolvedValueOnce({ ok: false, status, error: "Model request failed." })
        .mockResolvedValueOnce({ ok: true, modelRef: ollama.modelRef, latencyMs: 1, lines: [] });

      expect(await runSetup()).toMatchObject({
        status: "activated",
        selected: { kind: ollama.kind, modelRef: ollama.modelRef },
        attempts: [{ kind: "codex-cli", error: "Model request failed." }],
      });
      expect(fixture.activate).toHaveBeenCalledTimes(2);
      expect(fixture.prepare).not.toHaveBeenCalled();
    },
  );

  it("can select Ollama when Codex is genuinely absent", async () => {
    fixture.detect.mockResolvedValueOnce(detection([{ ...ollama }]));
    fixture.activate.mockResolvedValueOnce({
      ok: true,
      modelRef: "ollama/fixture",
      latencyMs: 1,
      lines: [],
    });

    expect(await runSetup()).toMatchObject({
      status: "activated",
      selected: { kind: "provider-auto:ollama-local", modelRef: "ollama/fixture" },
      attempts: [],
    });
    expect(fixture.activate).toHaveBeenCalledOnce();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("returns an existing model and ranked alternatives without starting a write", async () => {
    const current: SetupInferenceCandidate = {
      ...codex,
      kind: "existing-model",
      label: "Current model",
    };
    fixture.detect.mockResolvedValue(detection([openai, current, codex], { setupComplete: true }));

    expect(await runSetup()).toEqual({
      status: "configured",
      selected: { ...presentedCodex, kind: "existing-model", label: "Current model" },
      alternatives: [presentedCodex, presentedOpenai],
      attempts: [],
      installedPlugins: [],
    });
    expect(fixture.readConfig).toHaveBeenCalledOnce();
    expectUnused(fixture.activate, fixture.prepare, fixture.commit, fixture.audit);
  });

  it.each(["user", "agent"] as const)(
    "reports configured Codex sharing without a write (home scope: %s)",
    async (homeScope) => {
      fixture.readConfig.mockResolvedValue({
        config: {
          agents: {
            defaults: {
              model: codex.modelRef,
              models: { [codex.modelRef]: { agentRuntime: { id: "codex" } } },
            },
          },
          plugins: { entries: { codex: { config: { appServer: { homeScope } } } } },
        },
      });
      fixture.detect.mockResolvedValue(
        detection([{ ...codex, kind: "existing-model" }], { setupComplete: true }),
      );
      const result = await runSetup();
      expect(result).toMatchObject({ status: "configured" });
      expect(result.selected?.shared).toBe(homeScope === "user" ? true : undefined);
      expect(result.separateSignIn).toEqual(homeScope === "user" ? separateSignIn : undefined);
      expectUnused(fixture.activate, fixture.commit);
    },
  );

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

    expect(await runSetup()).toEqual({
      status: "activated",
      selected: { ...presentedCodex, shared: true },
      separateSignIn,
      alternatives: [presentedOpenai],
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

    expect(await runSetup()).toEqual({
      status: "needs-sign-in",
      signIn: { authOptionId: "openai-device-code", label: "ChatGPT" },
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
    const first = runGatewayAutomaticSetup(gateway, () => {});
    try {
      await awaitGateBeforeSettlement(
        started.promise,
        first,
        "automatic setup ended before discovery",
      );
      const joined = runGatewayAutomaticSetup(gateway, () => {});
      expect(joined).toBe(first);
      await expect(runSetup()).rejects.toBeInstanceOf(SetupAdmissionBusyError);
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

  it("rejects revoked requester authority after discovery before any activation or preparation", async () => {
    const started = createDeferred();
    const discovered = createDeferred<SetupInferenceDetection>();
    fixture.detect.mockImplementationOnce(() => {
      started.resolve();
      return discovered.promise;
    });
    let current = true;
    const run = runGatewayAutomaticSetup(context(), () => {
      if (!current) {
        throw new Error("Requester authority revoked");
      }
    });
    const rejection = expect(run).rejects.toThrow("Requester authority revoked");
    await awaitGateBeforeSettlement(started.promise, run, "setup ended before discovery");
    current = false;
    discovered.resolve(detection([codex]));
    await rejection;
    expectUnused(fixture.activate, fixture.prepare, fixture.commit);
  });

  it.each([false, true])(
    "prepares Codex and returns sign-in despite audit failure: %s",
    async (auditFails) => {
      if (auditFails) {
        fixture.audit.mockRejectedValueOnce(new Error("audit store unavailable"));
      }
      const prepared: OpenClawConfig = {
        plugins: {
          entries: {
            codex: {
              enabled: true,
              ...(auditFails ? { config: { sessionCatalog: { enabled: true } } } : {}),
            },
            ...(auditFails
              ? { anthropic: { config: { sessionCatalog: { enabled: false } } } }
              : {}),
          },
        },
      };
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

      expect(await runSetup()).toEqual({
        status: "needs-sign-in",
        alternatives: [],
        attempts: [],
        installedPlugins: ["codex"],
        signIn: { authOptionId: "openai-codex", label: "ChatGPT" },
      });
      expect(fixture.activate).not.toHaveBeenCalled();
      expect(fixture.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          requireApplied: true,
          config: {
            plugins: {
              entries: {
                codex: { enabled: true, config: { sessionCatalog: { enabled: auditFails } } },
                anthropic: { config: { sessionCatalog: { enabled: false } } },
              },
            },
          },
        }),
      );
    },
  );
});
