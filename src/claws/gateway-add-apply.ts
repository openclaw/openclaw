import type { ClawPluginAcknowledgement } from "../../packages/gateway-protocol/src/schema/claws.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawCronGateway } from "./cron.js";
import { digestClawValue } from "./digest.js";
import {
  buildGatewayClawAddPlan,
  projectGatewayClawAddPlan,
  type GatewayClawAddPlanningContext,
} from "./gateway-add-plan.js";
import { projectClawConfiguredAccess } from "./gateway-disclosure.js";
import { plansMatchAcrossSourceRoots } from "./gateway-plan-projection.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";

export class ClawGatewayPlanChangedError extends Error {
  constructor(message = "The Claw changed since review. Preview it again.") {
    super(message);
    this.name = "ClawGatewayPlanChangedError";
  }
}

export type GatewayClawAddApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  readiness: { ready: boolean; requirements: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

export async function applyClawAddForGateway(
  input: ClawHubFetchOptions & {
    source: ClawHubCoordinate;
    agentId?: string;
    planIntegrity: string;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeCapabilities?: readonly ClawPluginAcknowledgement[];
    getPlanningContext: () => Promise<GatewayClawAddPlanningContext>;
    assertCurrent: () => void;
    signal?: AbortSignal;
    stateDir?: string;
    reloadPlugins?: PluginInstallBatchReload;
    cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
  },
): Promise<GatewayClawAddApplyResult> {
  input.assertCurrent();
  let settledResult: GatewayClawAddApplyResult | undefined;
  try {
    const resolved = await withResolvedClawHubSource({
      coordinate: input.source,
      mode: "apply",
      ...(input.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.token ? { token: input.token } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.stateDir ? { stateDir: input.stateDir } : {}),
      run: async (source, trust, persistSource) => {
        input.assertCurrent();
        const initialContext = await input.getPlanningContext();
        input.assertCurrent();
        const initialPlan = await buildGatewayClawAddPlan(source, {
          ...initialContext,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        });
        const initialProjection = projectGatewayClawAddPlan(
          initialPlan,
          source.source.packageRoot,
          trust,
          initialContext.config,
        );
        if (initialProjection.planIntegrity !== input.planIntegrity) {
          throw new ClawGatewayPlanChangedError();
        }
        return await withOpenClawStateLease(
          {
            scope: "core:agent-deletion",
            key: initialPlan.agent.finalId,
            database: { scope: "shared", options: {} },
            leaseMs: 60_000,
            waitMs: 5_000,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Claw add",
            operationLabel: "claw.add.lease",
          },
          async (lease) => {
            const assertCurrent = () => {
              input.assertCurrent();
              lease.assertOwned();
            };
            assertCurrent();
            const currentContext = await input.getPlanningContext();
            assertCurrent();
            const currentPlan = await buildGatewayClawAddPlan(source, {
              ...currentContext,
              agentId: initialPlan.agent.finalId,
            });
            const currentProjection = projectGatewayClawAddPlan(
              currentPlan,
              source.source.packageRoot,
              trust,
              currentContext.config,
            );
            if (
              currentProjection.planIntegrity !== input.planIntegrity ||
              currentPlan.blockers.length > 0 ||
              currentPlan.actions.some((action) => action.blocked)
            ) {
              throw new ClawGatewayPlanChangedError();
            }
            const pluginConsent = bindClawPluginInstallConsent(
              currentProjection.pluginReviews,
              input.acknowledgeCapabilities,
              assertCurrent,
            );
            if (
              currentProjection.pluginReviews.some((review) => review.ownerAction === "install") &&
              !input.reloadPlugins
            ) {
              throw new Error("Gateway plugin activation is unavailable for this Claw.");
            }
            if (
              currentPlan.actions.some((action) => action.kind === "cronJob") &&
              !input.cronGateway
            ) {
              throw new Error("Gateway schedule installation is unavailable for this Claw.");
            }
            assertCurrent();
            const persisted = await persistSource();
            assertCurrent();
            const persistedContext = await input.getPlanningContext();
            assertCurrent();
            const persistedPlan = await buildGatewayClawAddPlan(persisted, {
              ...persistedContext,
              agentId: initialPlan.agent.finalId,
            });
            const persistedProjection = projectGatewayClawAddPlan(
              persistedPlan,
              persisted.source.packageRoot,
              trust,
              persistedContext.config,
            );
            if (
              persistedProjection.planIntegrity !== input.planIntegrity ||
              !persistedProjection.configuredAccess ||
              persistedPlan.blockers.length > 0 ||
              persistedPlan.actions.some((action) => action.blocked) ||
              !plansMatchAcrossSourceRoots({
                preview: currentPlan,
                previewRoot: source.source.packageRoot,
                persisted: persistedPlan,
                persistedRoot: persisted.source.packageRoot,
              })
            ) {
              throw new ClawGatewayPlanChangedError();
            }
            const reviewedAccessDigest = digestClawValue(persistedProjection.configuredAccess);
            assertCurrent();
            const result = await applyClawAddPlan(persistedPlan, {
              stateMode: "worker",
              assertCurrent,
              assertReviewedConfig: (config) => {
                let actualAccessDigest: string;
                try {
                  actualAccessDigest = digestClawValue(
                    projectClawConfiguredAccess({
                      config,
                      agentId: persistedPlan.agent.finalId,
                      desiredAgent: persistedPlan.agent.config,
                      operation: "add",
                    }),
                  );
                } catch {
                  throw new ClawAddMutationError(
                    "reviewed_access_changed",
                    "The effective Claw access changed since review. Preview it again.",
                  );
                }
                if (actualAccessDigest !== reviewedAccessDigest) {
                  throw new ClawAddMutationError(
                    "reviewed_access_changed",
                    "The effective Claw access changed since review. Preview it again.",
                  );
                }
              },
              config: persistedContext.config,
              consentPlanIntegrity: persistedPlan.planIntegrity,
              ...(pluginConsent ? { pluginConsent } : {}),
              ...(input.reloadPlugins ? { reloadPlugins: input.reloadPlugins } : {}),
              ...(input.cronGateway ? { cronGateway: input.cronGateway } : {}),
            });
            settledResult = {
              agentId: result.agent.finalId,
              status: result.status,
              readiness: persistedProjection.readiness ?? { ready: false, requirements: [] },
              ...(result.error
                ? {
                    error: {
                      code: result.error.code,
                      message:
                        "Claw installation needs attention. Review its status before retrying.",
                    },
                  }
                : {}),
            };
            return settledResult;
          },
        );
      },
    });
    return resolved.value;
  } catch (error) {
    if (settledResult) {
      return {
        ...settledResult,
        status: "partial",
        error: {
          code: "post_apply_cleanup_failed",
          message: "Claw state may have changed. Review its status before retrying.",
        },
      };
    }
    throw error;
  }
}
