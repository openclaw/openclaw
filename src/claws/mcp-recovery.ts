import { resolve } from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { readSourceConfigSnapshot } from "../config/io.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { withConfigSourceLocks } from "../config/write-lock.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { digestClawValue } from "./digest.js";
import { readClawInventory } from "./inventory-read.js";
import type { PersistedClawMcpServerRef } from "./mcp-records.js";
import { digestClawMcpServer } from "./mcp.js";
import { recoverClawMcpPendingRef } from "./provenance-write.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export const CLAW_MCP_RECOVERY_PLAN_SCHEMA_VERSION = "openclaw.clawMcpRecoveryPlan.v1" as const;
export const CLAW_MCP_RECOVERY_RESULT_SCHEMA_VERSION = "openclaw.clawMcpRecoveryResult.v1" as const;

type RecoveryRefIdentity = Omit<PersistedClawMcpServerRef, "error"> & {
  errorDigest?: string;
};

export type ClawMcpRecoveryPlan = {
  schemaVersion: typeof CLAW_MCP_RECOVERY_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  agentId: string;
  name: string;
  action: "complete" | "release" | "blocked";
  blocker?: { code: "mcp_config_modified"; message: string };
  ref: RecoveryRefIdentity;
  otherRefs: RecoveryRefIdentity[];
  stateDatabasePath: string;
  sourceConfigPath: string;
  liveConfig: {
    state: "exact" | "modified" | "missing";
    digest?: string;
    retained: true;
  };
  effect: string;
};

export type ClawMcpRecoveryResult = {
  schemaVersion: typeof CLAW_MCP_RECOVERY_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  status: "complete";
  planIntegrity: string;
  agentId: string;
  name: string;
  action: "complete" | "release";
  liveConfigRetained: true;
  updatedAtMs: number;
};

export class ClawMcpRecoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawMcpRecoveryError";
  }
}

type RecoveryOptions = OpenClawStateDatabaseOptions & {
  listMcpServers?: typeof listConfiguredMcpServers;
  nowMs?: number;
  assertCurrent?: () => void;
};

function refIdentity(ref: PersistedClawMcpServerRef): RecoveryRefIdentity {
  const { error, ...identity } = ref;
  return { ...identity, ...(error === undefined ? {} : { errorDigest: digestClawValue(error) }) };
}

function validateTarget(agentId: string, name: string): void {
  if (!agentId || agentId.trim() !== agentId || !name || name.trim() !== name) {
    throw new ClawMcpRecoveryError(
      "invalid_target",
      "Recovery requires an exact nonempty agent id and MCP server name.",
    );
  }
}

function configSourcePaths(snapshot: Pick<ConfigFileSnapshot, "path" | "includedPaths">): string[] {
  return [
    ...new Set(
      [snapshot.path, ...(snapshot.includedPaths ?? [])].map((pathname) => resolve(pathname)),
    ),
  ].toSorted();
}

async function readRecoverySnapshot(
  agentId: string,
  name: string,
  options: RecoveryOptions,
): Promise<{ plan: ClawMcpRecoveryPlan; expectedRefs: PersistedClawMcpServerRef[] }> {
  validateTarget(agentId, name);
  const context = captureOpenClawStateWorkerContext(options);
  const listed = await (options.listMcpServers ?? listConfiguredMcpServers)();
  if (!listed.ok) {
    throw new ClawMcpRecoveryError("mcp_config_unavailable", listed.error);
  }
  const inventory = await readClawInventory({
    ...options,
    path: context.admission.databasePath,
    readOnly: true,
  });
  const expectedRefs = inventory.mcpServers.filter((ref) => ref.name === name);
  const ref = expectedRefs.find((candidate) => candidate.agentId === agentId);
  if (!ref) {
    throw new ClawMcpRecoveryError(
      "mcp_ref_not_found",
      `Claw agent ${JSON.stringify(agentId)} has no MCP reference for ${JSON.stringify(name)}.`,
    );
  }
  if (ref.status !== "pending") {
    throw new ClawMcpRecoveryError(
      "mcp_ref_not_pending",
      `MCP reference ${JSON.stringify(name)} is ${ref.status}; only pending references need recovery.`,
    );
  }
  const server = listed.mcpServers[name];
  const digest = server ? digestClawMcpServer(server) : undefined;
  const state = !digest ? "missing" : digest === ref.configDigest ? "exact" : "modified";
  const action = state === "exact" ? "complete" : state === "missing" ? "release" : "blocked";
  const blocker =
    state === "modified"
      ? {
          code: "mcp_config_modified" as const,
          message: `Live MCP server ${JSON.stringify(name)} differs from its pending Claw reference; its previous ownership may still apply. No reference was released.`,
        }
      : undefined;
  const identity: Omit<ClawMcpRecoveryPlan, "planIntegrity"> = {
    schemaVersion: CLAW_MCP_RECOVERY_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true as const,
    mutationAllowed: false as const,
    agentId,
    name,
    action,
    ...(blocker ? { blocker } : {}),
    ref: refIdentity(ref),
    otherRefs: expectedRefs.filter((candidate) => candidate.agentId !== agentId).map(refIdentity),
    stateDatabasePath: context.admission.databasePath,
    sourceConfigPath: listed.path,
    liveConfig: {
      state,
      ...(digest ? { digest } : {}),
      retained: true as const,
    },
    effect:
      action === "complete"
        ? "Mark this pending Claw MCP reference complete; retain live MCP config unchanged."
        : action === "release"
          ? "Release this pending Claw MCP reference; retain live MCP config unchanged."
          : "No ownership mutation; inspect the live server and previous Claw ownership before retrying.",
  };
  return {
    plan: { ...identity, planIntegrity: digestClawValue(identity) },
    expectedRefs,
  };
}

export async function buildClawMcpRecoveryPlan(
  agentId: string,
  name: string,
  options: RecoveryOptions = {},
): Promise<ClawMcpRecoveryPlan> {
  return (await readRecoverySnapshot(agentId, name, options)).plan;
}

export async function applyClawMcpRecovery(
  agentId: string,
  name: string,
  consentPlanIntegrity: string,
  options: RecoveryOptions = {},
): Promise<ClawMcpRecoveryResult> {
  validateTarget(agentId, name);
  const context = captureOpenClawStateWorkerContext(options);
  const stateOptions = {
    path: context.admission.databasePath,
    env: options.env,
  };
  return await withOpenClawStateLease(
    {
      scope: "core:agent-deletion",
      key: agentId,
      database: { scope: "shared", options: stateOptions },
      leaseMs: 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      leaseLabel: "Claw MCP recovery",
      operationLabel: "claw.mcp.recover.agent.lease",
    },
    async (agentLease) =>
      await withClawMcpLifecycleLease(name, stateOptions, async (assertMcpOwned, mcpLease) => {
        const assertLeases = () => {
          agentLease.assertOwned();
          assertMcpOwned();
        };
        assertLeases();
        const observedSources = configSourcePaths(await readSourceConfigSnapshot());
        assertLeases();
        return await withConfigSourceLocks(
          observedSources,
          async (assertSourcesOwned) => {
            const assertCurrent = () => {
              assertLeases();
              assertSourcesOwned();
              options.assertCurrent?.();
            };
            assertCurrent();
            const lockedSources = configSourcePaths(await readSourceConfigSnapshot());
            assertCurrent();
            if (stableStringify(lockedSources) !== stableStringify(observedSources)) {
              throw new ClawMcpRecoveryError(
                "config_source_changed",
                "MCP config sources changed while acquiring recovery ownership; preview again.",
              );
            }
            const { plan, expectedRefs } = await readRecoverySnapshot(agentId, name, {
              ...options,
              ...stateOptions,
            });
            assertCurrent();
            if (plan.planIntegrity !== consentPlanIntegrity) {
              throw new ClawMcpRecoveryError(
                "plan_integrity_mismatch",
                "MCP ownership or live config changed; run mcp-recover --dry-run again.",
              );
            }
            if (plan.action === "blocked") {
              throw new ClawMcpRecoveryError(
                "mcp_config_modified",
                plan.blocker?.message ?? "Live MCP config changed; no ownership was released.",
              );
            }
            const claimed = await recoverClawMcpPendingRef(
              agentId,
              name,
              plan.action,
              expectedRefs,
              {
                ...stateOptions,
                agentLease,
                mcpLease,
                nowMs: options.nowMs,
                assertCurrent,
              },
            );
            assertCurrent();
            return {
              schemaVersion: CLAW_MCP_RECOVERY_RESULT_SCHEMA_VERSION,
              stability: CLAW_OUTPUT_STABILITY,
              status: "complete",
              planIntegrity: plan.planIntegrity,
              agentId,
              name,
              action: plan.action,
              liveConfigRetained: true,
              updatedAtMs: claimed.updatedAtMs,
            };
          },
          undefined,
          assertLeases,
        );
      }),
  );
}
