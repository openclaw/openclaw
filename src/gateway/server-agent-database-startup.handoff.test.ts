import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { getPreparedRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import { getPreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  activateSecretsRuntimeSnapshotIfCurrent,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { prepareHandoffEffectProbe } from "./server-agent-database-startup.effects.test-support.js";
import {
  holdInspectedAgentHandoff,
  prepareAgentHandoffStores,
} from "./server-agent-database-startup.handoff.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { testConfigRoot, testState } from "./test-helpers.runtime-state.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.server.js";

installGatewayTestHooks();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectPreparedModel(agentId: string) {
  const input = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true).find(
    (entry) => entry.agentId === agentId,
  );
  expect(input).toBeDefined();
  expect(input && getPreparedModelRuntimeSnapshot(input)).toBeDefined();
}

it.for([
  ["carlos", "success"],
  ["hal", "success"],
  ["carlos", "reject"],
  ["hal", "reject"],
] as const)(
  "keeps sibling usable when inspected agent %s publishes first (cleanup %s)",
  async ([firstAgent, cleanup], { signal }) => {
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { main: {}, carlos: {}, hal: {} },
    };
    testState.agentConfig = {
      systemAgent: { agentId: "main" },
      pdfModel: "anthropic/claude-opus-4-6",
    };
    vi.stubEnv("OPENCLAW_TEST_FLEET_SECRET", "synthetic-shared-fleet-secret");
    fs.mkdirSync(testConfigRoot.value, { recursive: true });
    fs.writeFileSync(
      path.join(testConfigRoot.value, "openclaw.json"),
      JSON.stringify({
        models: {
          providers: {
            anthropic: {
              api: "anthropic-messages",
              baseUrl: "http://127.0.0.1:43991/v1",
              models: [
                modelDefinition("claude-opus-4-6", {
                  api: "anthropic-messages",
                  agentRuntime: { id: "openclaw" },
                  contextWindow: 8192,
                }),
              ],
            },
          },
        },
      }),
    );
    const env = { ...process.env };
    const cfg = loadGatewayTestConfig();
    setRuntimeConfigSnapshot(cfg);
    const effectProbe =
      cleanup === "reject" ? await prepareHandoffEffectProbe(["carlos", "hal"], env) : undefined;
    await prepareAgentHandoffStores(["main", "carlos", "hal"], env);
    const {
      started: server,
      preparation: prepared,
      siblingPreparation: siblingReady,
      firstPublished,
      firstReleasing,
      secondPublished,
      releaseFirst,
    } = await withAgentDatabaseStartupAdmission(async (admission) => {
      const handoff = holdInspectedAgentHandoff(admission, { firstAgent, cleanup, env, signal });
      await assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: cfg });
      const preparation = admission.pendingPreparation;
      const siblingPreparation = admission.waitForAgentPreparation(
        firstAgent === "carlos" ? "hal" : "carlos",
        { env },
      );
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const started = await startTestGatewayServer(portClaim, {
        bind: "loopback",
        auth: { mode: "none" },
      });
      return { ...handoff, started, preparation, siblingPreparation };
    });
    try {
      await withinTest(firstReleasing.promise, signal);
      await withinTest(siblingReady!, signal);
      expect(await withinTest(secondPublished.promise, signal)).toBe(true);
      const inputs = listConfiguredOwnerInputs(getRuntimeConfig(), undefined, true);
      const firstInput = inputs.find((input) => input.agentId === firstAgent)!;
      const siblingInput = inputs.find(
        (input) => input.agentId !== firstAgent && input.agentId !== "main",
      )!;
      const siblingModel = getPreparedModelRuntimeSnapshot(siblingInput);
      expect(getPreparedModelRuntimeSnapshot(firstInput)).toBeDefined();
      expect(
        getPreparedRuntimeAuthProfileStoreSnapshot(
          firstInput.agentDir,
          firstInput.inheritedAuthDir,
        ),
      ).toBeDefined();
      await using effects = await effectProbe?.capture(firstAgent);
      if (effects) {
        expect(effects.first.auth.source).toBe("profile:anthropic:fleet");
        await expect(effects.first.complete()).resolves.toMatchObject({ stopReason: "stop" });
        await expect(effects.first.directComplete()).resolves.toMatchObject({ stopReason: "stop" });
        await expect(effects.first.isolated()).resolves.toMatchObject({
          assistant: { stopReason: "stop" },
        });
        await expect(effects.first.nativePdf()).resolves.toBe("Stubbed PDF completed");
        effects.arm();
        await effects.first.session.reloadPersistedTranscriptAsync();
        expect(effects.sql()).toContain(`${firstAgent}:read`);
      }
      const providerCallsBeforeRefusal = effects?.providerCalls.length ?? 0;
      const staleSecrets =
        cleanup === "reject"
          ? await prepareSecretsRuntimeSnapshot({
              config: getActiveSecretsRuntimeSnapshot()!.sourceConfig,
              env,
              includeConfigRefs: false,
            })
          : undefined;
      const secretsRevision = getActiveSecretsRuntimeSnapshotRevision();
      releaseFirst.resolve();
      await withinTest(prepared!, signal);
      const secrets = getActiveSecretsRuntimeSnapshot();
      if (cleanup === "reject") {
        expect(readAgentDatabaseAdmissionRefusal(firstAgent, { env })?.code).toBe(
          "agent-database-inspection-failed",
        );
        // Keep the input captured while readable: re-enumeration would hide a retained owner.
        expect(getPreparedModelRuntimeSnapshot(firstInput)).toBeUndefined();
        expect(
          getPreparedRuntimeAuthProfileStoreSnapshot(
            firstInput.agentDir,
            firstInput.inheritedAuthDir,
          ),
        ).toBeUndefined();
        expect(secrets?.authStores.some((store) => store.agentDir === firstInput.agentDir)).toBe(
          false,
        );
        expect(activateSecretsRuntimeSnapshotIfCurrent(staleSecrets!, secretsRevision)).toBe(false);
        expect(getPreparedModelRuntimeSnapshot(siblingInput)).toBe(siblingModel);
        const refusal = readAgentDatabaseAdmissionRefusal(firstAgent, { env });
        const refusalReason = expectDefined(refusal?.reason, "failed admission reason");
        const refused = { name: "AgentDatabaseAdmissionError", refusal };
        effects!.arm();
        // Healthy sibling reads may overlap refusals; only the refused agent must stay fenced.
        await effects!.sibling.session.reloadPersistedTranscriptAsync();
        const hostSql = observeHostDataSql();
        try {
          await expect.soft(effects!.first.complete()).rejects.toMatchObject(refused);
          await expect.soft(effects!.first.directComplete()).rejects.toMatchObject(refused);
          await expect.soft(effects!.first.isolated()).rejects.toMatchObject(refused);
          await expect.soft(effects!.first.nativePdf()).rejects.toMatchObject(refused);
          await expect.soft(effects!.first.pdfTool()).rejects.toThrow(refusalReason);
          await expect
            .soft(effects!.first.session.reloadPersistedTranscriptAsync())
            .rejects.toMatchObject(refused);
          await expect
            .soft(
              effects!.first.session.appendMessageAsync({
                role: "user",
                content: "Refused write",
                timestamp: 2,
              }),
            )
            .rejects.toMatchObject(refused);
          expect.soft(effects!.providerCalls.slice(providerCallsBeforeRefusal)).toEqual([]);
          expect.soft(hostSql.queries).toEqual([]);
        } finally {
          hostSql.restore();
        }
        await expect(effects!.sibling.complete()).resolves.toMatchObject({
          content: [{ type: "text", text: "Stubbed provider completed" }],
        });
        await expect(effects!.sibling.directComplete()).resolves.toMatchObject({
          stopReason: "stop",
        });
        await expect(effects!.sibling.isolated()).resolves.toMatchObject({
          assistant: { stopReason: "stop" },
        });
        await expect(effects!.sibling.nativePdf()).resolves.toBe("Stubbed PDF completed");
        await expect(effects!.sibling.pdfTool()).resolves.toMatchObject({
          details: { native: false },
        });
        await expect(
          effects!.sibling.session.appendMessageAsync({
            role: "user",
            content: "Healthy sibling write",
            timestamp: 3,
          }),
        ).resolves.toEqual(expect.any(String));
        await effects!.sibling.session.reloadPersistedTranscriptAsync();
        expect(effects!.sibling.session.buildSessionContext().messages).toContainEqual(
          expect.objectContaining({ role: "user", content: "Healthy sibling write" }),
        );
        expect(effects!.providerCalls.slice(providerCallsBeforeRefusal)).toEqual([
          ...Array<string>(5).fill(expectDefined(siblingInput.agentId, "prepared sibling agent")),
        ]);
        expect(effects!.sql()).toContain(`${siblingInput.agentId}:write`);
        expect(effects!.sql().some((operation) => operation.startsWith(`${firstAgent}:`))).toBe(
          false,
        );
      }
      for (const agentId of ["carlos", "hal"].filter(
        (id) => cleanup !== "reject" || id !== firstAgent,
      )) {
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
        expectPreparedModel(agentId);
        const database = openOpenClawAgentDatabase({ agentId, env });
        expect(database.agentId).toBe(agentId);
        expect(secrets?.authStores.some((store) => store.databasePath === database.path)).toBe(
          true,
        );
        expect(
          secrets?.degradedOwners?.some((owner) => owner.paths.includes(database.path)),
        ).not.toBe(true);
      }
    } finally {
      firstPublished.resolve();
      releaseFirst.resolve();
      await server.close();
    }
  },
);
