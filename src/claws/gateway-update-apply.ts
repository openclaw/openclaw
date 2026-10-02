import type {
  ClawPluginAcknowledgement,
  ClawSkillAcknowledgement,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawCronGateway } from "./cron.js";
import {
  ClawGatewayPlanChangedError,
  type GatewayClawAddApplyResult,
} from "./gateway-add-apply.js";
import {
  buildGatewayClawUpdatePlan,
  prepareGatewayClawUpdatePlanning,
} from "./gateway-lifecycle-plan.js";
import { bindClawLifecycleTrust, plansMatchAcrossSourceRoots } from "./gateway-plan-projection.js";
import { bindClawPluginInstallConsent } from "./gateway-plugin-consent.js";
import { bindClawSkillWarningConsent } from "./gateway-skill-consent.js";
import { applyClawUpdatePlan } from "./update-apply.js";

const log = createSubsystemLogger("claws/gateway-update");

export async function applyClawUpdateForGateway(
  input: ClawHubFetchOptions & {
    agentId: string;
    source: ClawHubCoordinate;
    planIntegrity: string;
    acknowledgeClawHubRisk?: boolean;
    acknowledgeCapabilities?: readonly ClawPluginAcknowledgement[];
    acknowledgeSkillWarnings?: readonly ClawSkillAcknowledgement[];
    getRuntimeConfig: () => OpenClawConfig;
    assertCurrent: () => void;
    signal?: AbortSignal;
    stateDir?: string;
    reloadPlugins?: PluginInstallBatchReload;
    cronGateway?: ClawCronGateway;
  },
): Promise<GatewayClawAddApplyResult> {
  input.assertCurrent();
  const initialConfig = input.getRuntimeConfig();
  const initialPrepared = await prepareGatewayClawUpdatePlanning({
    agentId: input.agentId,
    source: input.source,
    config: initialConfig,
    assertCurrent: input.assertCurrent,
  });
  input.assertCurrent();
  let mayHaveChanged = false;
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
        const initial = await buildGatewayClawUpdatePlan({
          agentId: input.agentId,
          source,
          config: initialConfig,
          prepared: initialPrepared,
        });
        const initialProjection = bindClawLifecycleTrust(initial.projection, trust);
        if (initialProjection.planIntegrity !== input.planIntegrity) {
          throw new ClawGatewayPlanChangedError();
        }
        return await withOpenClawStateLease(
          {
            scope: "core:agent-deletion",
            key: input.agentId,
            database: { scope: "shared", options: {} },
            leaseMs: 60_000,
            waitMs: 5_000,
            heartbeat: "worker",
            signal: input.signal,
            leaseLabel: "Claw update",
            operationLabel: "claw.update.lease",
          },
          async (lease) => {
            const assertCurrent = () => {
              input.assertCurrent();
              lease.assertOwned();
            };
            const planCurrent = async (verifiedSource: typeof source) => {
              assertCurrent();
              const config = input.getRuntimeConfig();
              const prepared = await prepareGatewayClawUpdatePlanning({
                agentId: input.agentId,
                source: input.source,
                config,
                assertCurrent,
              });
              const built = await buildGatewayClawUpdatePlan({
                agentId: input.agentId,
                source: verifiedSource,
                config,
                prepared,
              });
              assertCurrent();
              return {
                ...built,
                config,
                projection: bindClawLifecycleTrust(built.projection, trust),
              };
            };
            const current = await planCurrent(source);
            if (
              current.projection.planIntegrity !== input.planIntegrity ||
              current.projection.blockers.length > 0 ||
              current.plan.blockers.length > 0 ||
              current.plan.actions.some((action) => action.blocked)
            ) {
              throw new ClawGatewayPlanChangedError();
            }
            const pluginConsent = bindClawPluginInstallConsent(
              current.projection.pluginReviews,
              input.acknowledgeCapabilities,
              assertCurrent,
            );
            const skillConsent = bindClawSkillWarningConsent(
              current.projection.skillReviews,
              input.acknowledgeSkillWarnings,
              assertCurrent,
            );
            if (
              current.projection.pluginReviews.some((review) => review.ownerAction === "install") &&
              !input.reloadPlugins
            ) {
              throw new Error("Gateway plugin activation is unavailable for this Claw update.");
            }
            if (
              current.plan.actions.some(
                (action) => action.kind === "cronJob" && action.action !== "unchanged",
              ) &&
              !input.cronGateway
            ) {
              throw new Error("Gateway schedule updates are unavailable for this Claw.");
            }
            assertCurrent();
            mayHaveChanged = true;
            const persisted = await persistSource();
            const persistedPlan = await planCurrent(persisted);
            if (
              persistedPlan.projection.planIntegrity !== input.planIntegrity ||
              persistedPlan.projection.blockers.length > 0 ||
              persistedPlan.plan.blockers.length > 0 ||
              persistedPlan.plan.actions.some((action) => action.blocked) ||
              !plansMatchAcrossSourceRoots({
                preview: current.plan,
                previewRoot: source.source.packageRoot,
                persisted: persistedPlan.plan,
                persistedRoot: persisted.source.packageRoot,
              })
            ) {
              throw new ClawGatewayPlanChangedError();
            }
            assertCurrent();
            const result = await applyClawUpdatePlan(
              persistedPlan.plan,
              {
                targetManifest: persisted.manifest,
                targetClawMarkdownBody: persisted.clawMarkdownBody,
                targetOpenClawProfile: persisted.openClawProfile,
                targetSource: persisted.source,
              },
              {
                ...persistedPlan.stateOptions,
                stateMode: "worker",
                assertCurrent,
                config: persistedPlan.config,
                sourceMcpServers: persistedPlan.sourceMcpServers,
                packagePreflight: persistedPlan.packagePreflight,
                planPackageDeps: persistedPlan.packageDeps,
                consentPlanIntegrity: persistedPlan.plan.planIntegrity,
                ...(pluginConsent ? { pluginConsent } : {}),
                ...(skillConsent ? { skillConsent } : {}),
                ...(input.reloadPlugins ? { reloadPlugins: input.reloadPlugins } : {}),
                ...(input.cronGateway ? { cronGateway: input.cronGateway } : {}),
              },
            );
            settledResult = {
              agentId: result.agentId,
              status: result.status,
              readiness: persistedPlan.projection.readiness ?? { ready: false, requirements: [] },
            };
            return settledResult;
          },
        );
      },
    });
    return resolved.value;
  } catch (error) {
    if (mayHaveChanged || settledResult) {
      log.error(
        `Claw update outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        agentId: input.agentId,
        status: "partial",
        readiness: settledResult?.readiness ?? { ready: false, requirements: [] },
        error: {
          code: "update_outcome_uncertain",
          message: "Claw state may have changed. Review its status before retrying.",
        },
      };
    }
    throw error;
  }
}
