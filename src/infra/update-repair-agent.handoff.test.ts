import { afterEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { StreamFn } from "../agents/runtime/index.js";
import {
  buildEmbeddedRunnerAssistant,
  createMockUsage,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "../state/openclaw-agent-db-lease.js";
import { createOpenClawDatabaseMaintenanceScope as createMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState as withState } from "../test-utils/openclaw-test-state.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";
import { runUpdateRepairTurn as runTurn } from "./update-repair-agent.runtime.js";
import {
  createRepairAuthRuntime,
  repairModel,
  repairTurnInput as turnInput,
} from "./update-repair-agent.test-support.js";

const fixture = vi.hoisted(() => ({
  stream: vi.fn<StreamFn>(),
  handoff: undefined as ReturnType<typeof createManagedHandoffTestBinding> | undefined,
}));
// Only inference is synthetic; tool execution, auth and database lifecycle are real.
vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: () => fixture.stream,
}));
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => {
    if (!fixture.handoff) {
      throw new Error("Private handoff binding required");
    }
    fixture.handoff.assertPath();
    return fixture.handoff.directory;
  },
}));
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
  fixture.handoff = undefined;
  fixture.stream.mockReset();
});

it("settles the real repair turn without closing a parent lease before Doctor admission", async () => {
  await withState({ layout: "home" }, async (state) => {
    fixture.handoff = createManagedHandoffTestBinding(state.root);
    vi.stubEnv(
      "NODE_OPTIONS",
      [process.env.NODE_OPTIONS, fixture.handoff.nodeOption].filter(Boolean).join(" "),
    );
    fixture.handoff.assertPath(resolveManagedUpdateLeaseDatabasePath());
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    const agentDir = state.agentDir("owner");
    const auth = await createRepairAuthRuntime();
    const save = (profiles: AuthProfileStore["profiles"], dir = agentDir) =>
      auth.saveAuthProfileStore({ version: 1, profiles }, dir);
    const leases = () => readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env });
    const load = () =>
      auth.loadAuthProfileStoreForRuntime(agentDir, {
        readOnly: true,
        externalCli: { mode: "none" },
      });
    const seed = createMaintenanceScope();
    try {
      seed.run(() =>
        save({
          "fixture:repair": { type: "token", provider: "fixture", token: "synthetic-token" },
        }),
      );
    } finally {
      await seed.close();
    }
    expect(leases()).toEqual([]);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { skipBootstrap: true }, entries: { owner: { agentDir } } },
      tools: { toolSearch: { enabled: false } },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://repair.invalid/v1",
            api: "openai-responses",
            models: [repairModel()],
          },
        },
      },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    fixture.stream.mockImplementation((model) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: buildEmbeddedRunnerAssistant({
            content: [{ type: "text", text: "Repair completed." }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createMockUsage(1, 1),
            stopReason: "stop",
          }),
        });
        stream.end();
      });
      return stream;
    });
    // Keep cold loading outside the deterministic model-turn budget.
    await Promise.all([
      import("../agents/embedded-agent.js"),
      import("../agents/embedded-agent-runner/run-entry.js"),
    ]);
    const parent = createMaintenanceScope();
    try {
      parent.run(() => save({}, state.agentDir("independent")));
      const result = await parent.run(() =>
        runTurn(
          turnInput(state, {
            config,
            authProfileId: "fixture:repair",
            prompt: "Diagnose the failed update.",
            timeoutMs: 30000,
          }),
        ),
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        envelope: { status: "ok", final: "Repair completed." },
      });
      expect(fixture.stream).toHaveBeenCalledTimes(1);
      // These checks must precede fixture teardown: cleanup must not hide a leaked lease.
      expect(leases().map((lease) => lease.agent_id)).toEqual(["independent"]);
      const saved = load();
      expect(saved.usageStats?.["fixture:repair"]?.lastUsed).toBeGreaterThan(0);
      const admitDoctor = () =>
        beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
      await expect(admitDoctor()).rejects.toMatchObject({
        refusal: { kind: "deferred", reason: "agent-database-in-use" },
      });
      await parent.close();
      expect(leases()).toEqual([]);
      const doctor = await admitDoctor();
      expect(doctor).toBeDefined();
      try {
        doctor!.run(() => auth.saveAuthProfileStore(saved, agentDir));
      } finally {
        await doctor?.release();
      }
      expect(leases()).toEqual([]);
      expect(load()).toEqual(saved);
    } finally {
      await parent.close();
    }
  });
});
