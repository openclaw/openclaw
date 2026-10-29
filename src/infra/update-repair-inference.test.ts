import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import { makeModel } from "../agents/embedded-agent-runner/model.test-harness.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SystemAgentConfiguredRoute } from "../system-agent/inference-route.js";
import { selectUpdateRepairInference } from "./update-repair-inference.js";

const mocks = vi.hoisted(() => ({ hasAuth: vi.fn(), probe: vi.fn(), catalog: vi.fn() }));

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: mocks.hasAuth,
  resolveApiKeyForProviderCore: async (params: unknown) => {
    if (!mocks.hasAuth(params)) {
      throw new Error("Profile unavailable");
    }
    return { apiKey: "synthetic-credential" };
  },
}));
vi.mock("../agents/model-catalog.js", () => ({ loadManifestModelCatalog: mocks.catalog }));
vi.mock("../system-agent/setup-inference.js", () => ({ verifySetupInference: vi.fn() }));
vi.mock("../system-agent/setup-inference-turn.js", () => ({ runSetupInferenceTurn: mocks.probe }));

// mock-isolation: Project fixture routes without reading live agent state or credentials.
vi.mock("../system-agent/inference-route.js", () => ({
  resolveSystemAgentConfiguredRouteFromConfig: async (
    config: OpenClawConfig,
    agentId: string,
  ): Promise<SystemAgentConfiguredRoute | null> => {
    const configured = resolveAgentEntry(config, agentId)?.model ?? config.agents?.defaults?.model;
    const raw = typeof configured === "string" ? configured : configured?.primary;
    if (!raw) {
      return null;
    }
    const { model: modelLabel, profile: authProfileId } = splitTrailingAuthProfile(raw);
    const slash = modelLabel.indexOf("/");
    const provider = modelLabel.slice(0, slash);
    return {
      runner: provider === "local-cli" ? "cli" : "embedded",
      provider,
      model: modelLabel.slice(slash + 1),
      modelLabel,
      runConfig: config,
      sourceConfig: config,
      agentId,
      agentDir: `/isolated/${agentId}`,
      ...(authProfileId ? { authProfileId } : {}),
    };
  },
}));

const runtime: RuntimeEnv = { log() {}, error() {}, exit() {} };
function ownerConfig(primary: string, fallbacks: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: { systemAgent: { agentId: "owner" } },
      entries: { owner: { model: { primary, fallbacks } } },
    },
  };
}
const config = ownerConfig("zeta/primary@owner-profile", ["zeta/backup", "zeta/spare"]);
config.agents!.defaults!.model = {
  primary: "alpha/default",
  fallbacks: ["alpha/default-fallback"],
};
config.agents!.entries!.other = { model: "alpha/other" };
const probedModels = () => mocks.probe.mock.calls.map(([params]) => params.route.modelLabel);

function select(cfg = config, signal = new AbortController().signal) {
  return selectUpdateRepairInference({ config: cfg, runtime, signal, timeoutMs: 10_000 });
}

beforeEach(() => {
  mocks.hasAuth.mockReset().mockReturnValue(true);
  mocks.catalog.mockReset().mockReturnValue([]);
  mocks.probe.mockReset().mockResolvedValue({ ok: true, latencyMs: 1, text: "OK", auth: {} });
});

it.each([1, 3])(
  "preserves auth ownership while falling back after %s owner failures",
  async (failures) => {
    for (let index = 0; index < failures; index++) {
      mocks.probe.mockResolvedValueOnce({
        ok: false,
        status: failures === 1 ? "format" : "unavailable",
        error: "route unavailable",
      });
    }
    const result = await select();

    expect(probedModels()).toEqual(
      ["zeta/primary", "zeta/backup", "zeta/spare", "alpha/other"].slice(0, failures + 1),
    );
    expect(mocks.probe.mock.calls[0]?.[0].route).toMatchObject({
      authProfileId: "owner-profile",
      agentDir: "/isolated/owner",
    });
    expect(mocks.hasAuth.mock.calls[0]?.[0]).toMatchObject({
      modelId: "primary",
      profileId: "owner-profile",
      lockedProfile: true,
      allowAuthProfileFallback: false,
    });
    expect(result).toMatchObject({
      ok: true,
      route:
        failures === 1
          ? { agentId: "owner", model: "backup", provider: "zeta" }
          : { agentId: "other", agentDir: "/isolated/other" },
      ...(failures === 1 ? { modelFallbacks: ["zeta/spare"] } : {}),
    });
  },
);

it("skips unauthenticated, CLI, manifest non-tool and custom non-tool routes before probing", async () => {
  const cfg: OpenClawConfig = {
    ...ownerConfig("zeta/no-auth", [
      "local-cli/model",
      "zeta/text-only",
      "custom/text-only",
      "zeta/tools",
    ]),
    models: {
      providers: {
        custom: {
          baseUrl: "http://127.0.0.1:12345",
          models: [{ ...makeModel("text-only"), compat: { supportsTools: false } }],
        },
      },
    },
  };
  mocks.catalog.mockReturnValue([
    { provider: "zeta", id: "text-only", compat: { supportsTools: false } },
  ]);
  mocks.hasAuth.mockImplementation(({ modelId }) => modelId !== "no-auth");
  const result = await select(cfg);

  expect(result).toMatchObject({ ok: true, route: { model: "tools" } });
  expect(probedModels()).toEqual(["zeta/tools"]);
  expect(mocks.hasAuth.mock.calls.map(([params]) => params.modelId)).toEqual(["no-auth", "tools"]);
});

it("returns unavailable when no route has usable auth", async () => {
  mocks.hasAuth.mockReturnValue(false);
  expect(await select()).toMatchObject({
    ok: false,
    reason: expect.stringContaining("usable inference"),
  });
  expect(mocks.probe).not.toHaveBeenCalled();
});

it("awaits an aborted probe's completion before returning", async () => {
  const controller = new AbortController();
  let drained = false;
  mocks.probe.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    queueMicrotask(() => controller.abort());
    if (!signal.aborted) {
      await once(signal, "abort");
    }
    await setImmediate();
    drained = true;
    return { ok: false, status: "timeout", error: "aborted" };
  });
  const result = await select(config, controller.signal);
  expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("budget") });
  expect(drained).toBe(true);
  expect(mocks.probe).toHaveBeenCalledOnce();
});
