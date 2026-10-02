import { afterEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import { markEmbeddedRunAuthProfileSuccess } from "../agents/embedded-agent-runner/run/auth-profile-success.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  readActiveOpenClawAgentDatabaseLeasesReadOnly,
} from "../state/openclaw-agent-db-lease.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";
import { runUpdateRepairTurn } from "./update-repair-agent.runtime.js";

const fixture = vi.hoisted(() => ({
  run: vi.fn(),
  handoff: undefined as ReturnType<typeof createManagedHandoffTestBinding> | undefined,
}));
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => {
    if (!fixture.handoff) {
      throw new Error("Private handoff binding required before database admission");
    }
    fixture.handoff.assertPath();
    return fixture.handoff.directory;
  },
}));
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: fixture.run }));
vi.mock("../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: async (params: {
    runCandidate: (provider: string, model: string, options: object) => Promise<unknown>;
  }) => ({
    result: await params.runCandidate("fixture", "repair", {}),
    provider: "fixture",
    model: "repair",
    terminal: { outcome: { status: "ok" } },
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  fixture.handoff = undefined;
  fixture.run.mockReset();
});

it.each([false, true])(
  "releases only repair credential leases after the terminal handoff (parent lease=%s)",
  async (parentLease) => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      fixture.handoff = createManagedHandoffTestBinding(state.root);
      vi.stubEnv(
        "NODE_OPTIONS",
        [process.env.NODE_OPTIONS, fixture.handoff.nodeOption].filter(Boolean).join(" "),
      );
      expect(fixture.handoff.assertPath(resolveManagedUpdateLeaseDatabasePath())).toBe(
        fixture.handoff.databasePath,
      );
      vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
      const agentDir = state.agentDir("owner");
      const auth = createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
      const parent = createOpenClawDatabaseMaintenanceScope();
      if (parentLease) {
        parent.run(() =>
          auth.saveAuthProfileStore({ version: 1, profiles: {} }, state.agentDir("independent")),
        );
      }
      try {
        fixture.run.mockImplementation(async (input: RunEmbeddedAgentParams) => {
          expect(input.sessionPersistence).toBe("detached");
          expect(input.agentDir).toBe(agentDir);
          auth.saveAuthProfileStore(
            {
              version: 1,
              profiles: {
                "fixture:repair": { type: "token", provider: "fixture", token: "synthetic-token" },
              },
            },
            agentDir,
          );
          const leases = readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env });
          expect(leases.map((lease) => lease.agent_id).toSorted()).toEqual(
            parentLease ? ["independent", "owner"] : ["owner"],
          );
          expect(leases.every((lease) => lease.owner_pid === process.pid)).toBe(true);
          expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toThrow(
            /still open in process/,
          );
          // The embedded runner starts this durable write without awaiting its completion.
          markEmbeddedRunAuthProfileSuccess({
            agentDir,
            profileId: "fixture:repair",
            provider: "fixture",
            profileStore: auth.loadAuthProfileStoreForRuntime(agentDir, {
              readOnly: true,
              externalCli: { mode: "none" },
            }),
            runId: input.runId,
            sessionId: input.sessionId,
          });
          return {
            meta: {
              durationMs: 1,
              stopReason: "tool_calls",
              pendingToolCalls: [
                {
                  name: "request_update_maintenance",
                  arguments: '{"operation":"update-repair"}',
                },
              ],
            },
          };
        });
        const config = {
          plugins: { enabled: false },
          agents: { entries: { owner: { agentDir } } },
        };
        const result = await parent.run(() =>
          runUpdateRepairTurn({
            target: { ...state, installRoot: state.workspaceDir },
            route: {
              runner: "embedded",
              provider: "fixture",
              model: "repair",
              modelLabel: "fixture/repair",
              agentId: "owner",
              agentDir,
              runConfig: config,
              sourceConfig: config,
            },
            modelFallbacks: [],
            prompt: "Repair.",
            timeoutMs: 10_000,
            maxToolCalls: 1,
            signal: new AbortController().signal,
            maintenanceHandoff: true,
          }),
        );
        // Check before test cleanup: otherwise fixture teardown hides the production leak.
        expect(
          readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env }).map(
            (lease) => lease.agent_id,
          ),
        ).toEqual(parentLease ? ["independent"] : []);
        if (parentLease) {
          expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toThrow(
            /Agent independent/,
          );
        } else {
          expect(() =>
            assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env }),
          ).not.toThrow();
        }
        expect(result).toMatchObject({
          status: "completed",
          envelope: { status: "ok" },
          maintenance: { operation: "update-repair" },
        });
        expect(
          fixture.run.mock.calls[0]?.[0].clientTools?.map(
            (tool: { function: { name: string } }) => tool.function.name,
          ),
        ).toEqual(["request_update_maintenance"]);
        const saved = auth.loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          externalCli: { mode: "none" },
        });
        expect(saved.usageStats?.["fixture:repair"]?.lastUsed).toBeGreaterThan(0);
        const admitDoctor = () =>
          beginDoctorMaintenance({
            options: { repair: true, nonInteractive: true },
            root: null,
            runtime: { log() {}, error() {}, exit() {} },
          });
        if (parentLease) {
          await expect(admitDoctor()).rejects.toMatchObject({
            refusal: { kind: "deferred", reason: "agent-database-in-use" },
          });
        } else {
          const doctor = await admitDoctor();
          expect(doctor).toBeDefined();
          try {
            // Exercise the real maintenance owner after the repair, then reopen
            // durable credentials as the next startup would.
            doctor!.run(() => auth.saveAuthProfileStore(saved, agentDir));
          } finally {
            await doctor?.release();
          }
          expect(readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).toEqual([]);
          expect(
            auth.loadAuthProfileStoreForRuntime(agentDir, {
              readOnly: true,
              externalCli: { mode: "none" },
            }),
          ).toEqual(saved);
        }
      } finally {
        await parent.close();
      }
    });
  },
);
