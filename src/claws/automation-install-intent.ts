import { z } from "zod";
import { listAgentEntries, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import type { ClawCronInstallUpdate } from "./cron-update-contract.js";
import { digestClawValue } from "./digest.js";
import { normalizeWorkspaceConfig, resolveMigrationAgentSettings } from "./migrate-validation.js";
import type { PersistedClawInstall } from "./provenance-types.js";

const text = z.string().min(1).max(4096);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const clawAutomationInstallIntentSchema = z
  .object({
    claw: z
      .object({
        kind: z.enum(["package", "development"]),
        name: text,
        version: text,
        packageRoot: text,
        manifestPath: text,
        integrityKind: z.enum(["artifact", "development-snapshot"]),
        integrity: digest,
        byteLength: z.number().int().nonnegative().safe(),
      })
      .strict(),
    planIntegrity: digest,
    expectedClaw: z.object({ version: text, integrity: digest }).strict(),
    agentConfigDigest: digest,
  })
  .strict();

export type ClawAutomationInstallIntent = z.infer<typeof clawAutomationInstallIntentSchema>;

export function clawAutomationInstallIntent(
  install: ClawCronInstallUpdate,
): ClawAutomationInstallIntent {
  return clawAutomationInstallIntentSchema.parse({
    claw: install.plan.claw,
    planIntegrity: install.plan.planIntegrity,
    expectedClaw: install.expectedClaw
      ? { version: install.expectedClaw.version, integrity: install.expectedClaw.integrity }
      : undefined,
    agentConfigDigest: install.agentConfigDigest ?? digestClawValue(install.plan.agent.config),
  });
}

/** Provenance can change artifact identity, never select an agent's live paths or permissions. */
export function reconstructClawAutomationInstallUpdate(params: {
  intent: ClawAutomationInstallIntent;
  current: PersistedClawInstall;
  config: OpenClawConfig;
}): ClawCronInstallUpdate {
  const { intent, current, config } = params;
  const entry = listAgentEntries(config).find((agent) => agent.id === current.agentId);
  if (!entry) {
    throw new Error("Claw automation install no longer has its configured agent.");
  }
  if (
    resolveIdentityPathViaExistingAncestorSync(
      resolveAgentWorkspaceDir(config, current.agentId),
    ) !== resolveIdentityPathViaExistingAncestorSync(current.workspace)
  ) {
    throw new Error("Claw agent workspace changed before automation installation.");
  }
  const agent = { ...entry, workspace: current.workspace };
  const agentConfigDigest = digestClawValue(
    current.agentOrigin === "adopted"
      ? normalizeWorkspaceConfig(resolveMigrationAgentSettings(config, agent), current.workspace)
      : agent,
  );
  if (agentConfigDigest !== intent.agentConfigDigest) {
    throw new Error("Claw agent configuration changed before automation installation.");
  }
  return {
    plan: {
      claw: intent.claw,
      manifestSchemaVersion: 1,
      planIntegrity: intent.planIntegrity,
      agent: { finalId: current.agentId, workspace: current.workspace, config: agent },
      actions: current.agentOwnedPaths.map((target) => ({ kind: "agent", target })),
    },
    expectedClaw: intent.expectedClaw,
    agentConfigDigest,
  };
}
