/** Doctor check for configured model references that have no installed provider owner. */
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveKnownModelRefMigrationTarget } from "../commands/doctor/shared/codex-route-warnings.js";
import type { HealthCheck, HealthCheckContext, HealthFinding } from "./health-checks.js";

/** One published model row: the provider id plus the model id it serves. */
type PublishedModelCatalogRow = { provider: string; id: string };

/**
 * Reads the rows a selected Gateway published, over the same read-only
 * models.list transport `models list` uses. Returns undefined only when the
 * target is local and no Gateway owns it, so callers can use offline rows.
 */
async function readRunningGatewayCatalogRows(
  ctx: HealthCheckContext,
): Promise<readonly PublishedModelCatalogRow[] | undefined> {
  const { callGateway, isImplicitLocalGatewayTarget } = await import("../gateway/call.js");
  const localTarget = await isImplicitLocalGatewayTarget({ config: ctx.cfg });
  const explicitPort = Boolean(ctx.env?.OPENCLAW_GATEWAY_PORT?.trim());
  const gatewayOwner =
    !localTarget || explicitPort
      ? undefined
      : await (
          await import("../infra/gateway-lock.js")
        ).readActiveGatewayLockIdentity({
          requireInspection: true,
        });
  if (localTarget && !explicitPort && !gatewayOwner) {
    return undefined;
  }
  const { GATEWAY_SERVER_CAPS } =
    await import("../../packages/gateway-protocol/src/server-capabilities.js");
  const result = await callGateway<{ models: readonly { id: string; provider: string }[] }>({
    config: ctx.cfg,
    method: "models.list",
    requiredCapabilities: [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG],
    ...(gatewayOwner ? { localPortOverride: gatewayOwner.port } : {}),
    params: { view: "all" },
  });
  return result.models.map((model) => ({ provider: model.provider, id: model.id }));
}

/**
 * Reads the published rows Doctor may trust, read-only and without provider
 * discovery. An unowned local target can use offline rows; a selected Gateway
 * owns its own failure, so an unreachable one leaves the offline verdict.
 */
async function readPublishedModelCatalogRows(
  ctx: HealthCheckContext,
): Promise<readonly PublishedModelCatalogRow[]> {
  try {
    const gatewayRows = await readRunningGatewayCatalogRows(ctx);
    if (gatewayRows) {
      return gatewayRows;
    }
  } catch {
    // Do not replace a failed selected Gateway with a different local inventory.
    return [];
  }
  try {
    const { readPreparedModelCatalog } = await import("../agents/prepared-model-catalog.js");
    return await readPreparedModelCatalog({
      config: ctx.cfg,
      agentId: resolveDefaultAgentId(ctx.cfg),
      ...(ctx.env ? { env: ctx.env } : {}),
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
      readOnly: true,
    });
  } catch {
    return [];
  }
}

export function createModelReferenceCheck(): HealthCheck {
  return {
    id: "core/doctor/model-references",
    kind: "core",
    description: "Configured model references have installed or configured provider owners.",
    source: "doctor",
    async detect(ctx) {
      const { inspectConfiguredModelReferences } =
        await import("../commands/models/model-reference-validation.js");
      const params = {
        cfg: ctx.cfg,
        env: ctx.env,
        workspaceDir: ctx.cwd,
      };
      const offline = inspectConfiguredModelReferences(params);
      // Providers that discover their catalog at runtime publish ids offline
      // metadata cannot enumerate. Only read the cached catalog when an active
      // ref is actually unconfirmed, so the common path stays offline and cheap.
      const inspections = offline.some(
        (inspection) => inspection.active && inspection.status === "unknown-model",
      )
        ? inspectConfiguredModelReferences({
            ...params,
            publishedModelCatalog: await readPublishedModelCatalogRows(ctx),
          })
        : offline;
      return inspections.flatMap((inspection): HealthFinding[] => {
        const migrationTarget = resolveKnownModelRefMigrationTarget(ctx.cfg, inspection.ref);
        const migrationFinding = migrationTarget
          ? {
              message: `Configured model "${inspection.ref}" is a legacy reference. Doctor can migrate it to "${migrationTarget}".`,
              requirement: `canonical model reference "${migrationTarget}"`,
              fixHint: `Run \`openclaw doctor --fix\` to migrate this model reference to "${migrationTarget}".`,
            }
          : undefined;
        if (inspection.status === "unknown-provider") {
          return [
            {
              checkId: "core/doctor/model-references",
              severity: "warning",
              source: "doctor",
              target: inspection.ref,
              ...(migrationFinding ?? {
                message: `Configured model "${inspection.ref}" uses unknown provider "${inspection.provider}". No installed plugin manifest or models.providers entry declares it.`,
                requirement: "an installed plugin manifest or models.providers configuration",
                fixHint:
                  "Install a plugin that declares this provider, configure it under models.providers, or remove the model reference.",
              }),
            },
          ];
        }
        // A provider that ships no catalog rows cannot confirm or deny a model
        // id offline; the generic advisory would be unactionable there, so only
        // a legacy-reference migration is still worth reporting.
        if (inspection.status === "uncatalogued-provider" && !migrationFinding) {
          return [];
        }
        if (
          (inspection.status === "unknown-model" ||
            inspection.status === "uncatalogued-provider") &&
          inspection.active
        ) {
          return [
            {
              checkId: "core/doctor/model-references",
              severity: "info",
              source: "doctor",
              target: inspection.ref,
              ...(migrationFinding ?? {
                message: `Configured model "${inspection.ref}" uses a known provider but is not in the local model catalog. It may be newly released or self-hosted.`,
                requirement: "a provider-supported model id",
                fixHint:
                  "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
              }),
            },
          ];
        }
        return [];
      });
    },
  };
}
