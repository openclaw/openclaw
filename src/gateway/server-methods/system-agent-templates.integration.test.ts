import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { TemplateLifecyclePlanResult } from "../../../packages/gateway-protocol/src/schema/templates.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  createSystemAgentTool,
  type SystemAgentToolDirective,
} from "../../agents/tools/system-agent-tool.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { loadSystemAgentOverview } from "../../system-agent/overview.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "../../system-agent/system-agent.test-helpers.js";
import type { withResolvedClawHubSource } from "../../templates/clawhub-source.js";
import { readTemplateManifestFile } from "../../templates/reader.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import { withSystemAgentTemplateRequests } from "./system-agent-templates.js";
import type { GatewayRequestHandlerOptions, GatewaySystemAgentSession } from "./types.js";

const { registry, greeting } = vi.hoisted(() => ({
  registry: vi.fn(),
  greeting: vi.fn(async () => {}),
}));
// mock-isolation: Only the external registry's verified bytes/trust and the subsequent
// greeting model call are fixed. Tool, engine, approval store, installer, config,
// workspace, ordinary admission and session finalization use their production owners.
vi.mock("../../templates/clawhub-source.js", async (original) => ({
  ...(await original<typeof import("../../templates/clawhub-source.js")>()),
  withResolvedClawHubSource: registry,
}));
vi.mock("./agents-onboarding.js", async (original) => ({
  ...(await original<typeof import("./agents-onboarding.js")>()),
  startAgentOnboardingConversation: greeting,
}));
// mock-isolation: No websocket roster is part of this request-owner composition.
vi.mock("./session-change-event.js", () => ({ emitSessionsChanged: vi.fn() }));

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  resetAgentRunRegistryForTest();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const source = { packageName: "@fixture/setup-template", version: "1.0.0" };
const agentId = "setup-template";

it.for([
  "approve",
  "direct",
  "automatic",
  "deny",
  "cancel",
  "revoked",
  "labs",
  "authority",
  "trust",
  "trust-approved",
  "unavailable",
  "changed",
] as const)(
  "routes a published Template through the setup helper and existing policy: %s",
  async (scenario, test) => {
    const automatic = scenario === "automatic" || scenario === "trust-approved";
    const succeeds = ["approve", "direct", "automatic", "trust-approved"].includes(scenario);
    await withOpenClawTestState({ label: "setup-template" }, async (state) => {
      let config: OpenClawConfig = {
        gateway: { controlUi: { experimental: { templates: scenario !== "labs" } } },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
          entries: { main: { workspace: state.path("main-workspace") } },
        },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const root = state.statePath("published-release");
      await state.writeJson("published-release/package.json", {
        name: source.packageName,
        version: source.version,
        openclaw: { template: "CLAW.md" },
      });
      await state.writeText(
        "published-release/CLAW.md",
        "---\nschemaVersion: 1\nagent:\n  id: setup-template\n  name: Setup Template\n---\n\nOnly fixture instructions.\n",
      );
      const artifact = await readTemplateManifestFile(root);
      if (!artifact.ok) {
        throw new Error(JSON.stringify(artifact.diagnostics));
      }
      artifact.source = {
        ...artifact.source,
        kind: "package",
        name: source.packageName,
        version: source.version,
        integrityKind: "artifact",
      };
      const trust = {
        riskAcknowledgementRequired: scenario.startsWith("trust"),
        ...(scenario.startsWith("trust")
          ? { trustWarning: "Fixture release requires explicit trust consent." }
          : {}),
        trustRecord: {
          clawhubTrustDisposition: "clean" as const,
          clawhubTrustCheckedAt: "2026-11-14T00:00:00.000Z",
        },
      };
      registry.mockImplementation(
        async (input: Parameters<typeof withResolvedClawHubSource>[0]) => {
          if (scenario === "unavailable") {
            throw new Error("Fixture private registry diagnostic");
          }
          return { value: await input.run(artifact, trust, async () => artifact), ...trust };
        },
      );
      const unsubscribe = registerRuntimeConfigWriteListener((event) => {
        const application = getRuntimeConfigWriteApplication(event);
        if (!application) {
          return;
        }
        const claim = application.claim();
        if (!claim) {
          throw new Error("Unclaimed Template runtime write");
        }
        config = event.sourceConfig;
        setRuntimeConfigSnapshot(config);
        claim.settle("applied");
      });
      const metadata = createSystemAgentPluginMetadataTestSnapshot();
      try {
        await metadata.run(async () => {
          const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
          let modelReview: TemplateLifecyclePlanResult | undefined;
          const engine = new SystemAgentChatEngine({
            verifiedInference: fixture.binding,
            surface: "gateway",
            operatorApprovalOnly: scenario !== "direct",
            classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
            deps: { loadOverview: () => loadSystemAgentOverview({ agentId: "main" }) },
            runAgentTurn: async (turn) => {
              let args: Record<string, unknown> = { action: "template_review", source };
              if (!turn.input.endsWith("Review this published Template")) {
                const line = turn.input
                  .split("\n")
                  .find((item) => item.startsWith("[template-result] "));
                if (!line) {
                  throw new Error("Template result never reached the model input");
                }
                const result = JSON.parse(line.slice("[template-result] ".length)) as string;
                if (turn.input.endsWith("Retry the same Template installation")) {
                  expect(result).toContain('"status":"complete"');
                } else {
                  modelReview = JSON.parse(
                    result.slice(result.indexOf("{")),
                  ) as TemplateLifecyclePlanResult;
                }
                if (!modelReview) {
                  throw new Error("The model has not received a Template review");
                }
                args = {
                  action: "template_install",
                  source,
                  agentId: modelReview.target.agentId,
                  planIntegrity: scenario === "changed" ? "stale-plan" : modelReview.planIntegrity,
                  approved: true,
                  ...(scenario === "trust-approved" ? { acknowledgeClawHubRisk: true } : {}),
                };
              }
              const directiveRef: { current?: SystemAgentToolDirective } = {};
              const tool = createSystemAgentTool({
                surface: "gateway",
                operatorApprovalOnly: turn.operatorApprovalOnly,
                proposalRef: turn.session.proposalRef,
                directiveRef,
              });
              await tool.execute("fixture-tool-call", args);
              return { text: "Host review requested.", directive: directiveRef.current };
            },
          });
          let current = true;
          const controller = new AbortController();
          const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(test, {
            approvalKind: "system-agent",
            resolveAllowedDecisions: (request) => request.allowedDecisions,
            validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
          });
          const session: GatewaySystemAgentSession = {
            engine,
            welcome: "",
            ownerKey: "fixture",
            lastUsedAt: 0,
          };
          const sessions = new Map([["template-helper", session]]);
          const options = {
            req: { type: "req", id: "helper-install", method: "openclaw.chat" },
            params: {},
            respond: vi.fn(),
            isWebchatConnect: () => false,
            client: {
              connId: "original-admin",
              connect: {
                role: "operator",
                scopes: [scenario === "authority" ? "operator.read" : "operator.admin"],
                client: { mode: "ui" },
              },
            },
            signal: controller.signal,
            hasCurrentClientAuthority: () => current,
            context: {
              getRuntimeConfig: () => config,
              broadcastToConnIds: vi.fn(),
              broadcast: vi.fn(),
              systemAgentApprovalManager: manager,
              systemAgentSessions: sessions,
            },
          } as unknown as GatewayRequestHandlerOptions;
          const operationalRunInstance = createOperationalRunInstanceRef("template-helper-run");
          const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
          const run = async (body: () => Promise<void>) =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:main",
                operationalRunInstance,
                fullPermission: automatic,
                ...(automatic ? { assertAutoApproveChangesCurrent: () => {} } : {}),
                approvalSignals: [controller.signal],
              },
              () => withSystemAgentTemplateRequests(async () => body())(options),
            );
          try {
            await run(async () => {
              if (scenario === "authority" || scenario === "labs" || scenario === "unavailable") {
                const review = await engine.handle("Review this published Template");
                expect(review.text).toContain(
                  scenario === "labs"
                    ? "Settings > Labs"
                    : scenario === "authority"
                      ? "operator.admin"
                      : "Template Add preview is unavailable",
                );
                expect(review.text).not.toContain("private registry diagnostic");
                expect(engine.getPendingOperatorProposal()).toBeNull();
                return;
              }
              await engine.handle("Review this published Template");
              expect(
                (await readConfigFileSnapshot()).config.agents?.entries?.[agentId],
              ).toBeUndefined();
              if (scenario === "trust" || scenario === "changed") {
                const blocked = await engine.handle("Install this Template");
                expect(blocked.text).toContain(
                  scenario === "trust" ? "acknowledgeClawHubRisk" : "changed since review",
                );
                expect(engine.getPendingOperatorProposal()).toBeNull();
                return;
              }
              const proposed = await engine.handle("Install this Template");
              expect(proposed.applied).not.toBe(true);
              const proposal = engine.getPendingOperatorProposal();
              if (!proposal) {
                throw new Error("Template installation was not proposed");
              }
              const resolve = await prepareDelegatedSystemAgentApproval({
                context: options.context,
                sessions,
                session,
                sessionId: "template-helper",
                delegation: { agentId: "main", sessionKey: "agent:main:main" },
              });
              const pending =
                scenario === "direct"
                  ? { kind: "completed" as const, reply: await engine.handle("yes") }
                  : await resolve(proposal);
              let reply;
              if (pending.kind === "approval") {
                expect(scenario).not.toBe("automatic");
                const description = (await manager.getSnapshot(pending.id))?.request.description;
                expect(description).toContain(modelReview?.planIntegrity);
                expect(description).toContain(modelReview?.target.workspace);
                if (scenario === "revoked") {
                  current = false;
                }
                if (scenario === "cancel") {
                  controller.abort(new Error("Fixture requester cancelled"));
                  expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
                }
                if (scenario === "cancel") {
                  await manager.forceDenyIfRuntimeAuthorityClosed(pending.id);
                } else {
                  await manager.resolve(
                    pending.id,
                    scenario === "deny" ? "deny" : "allow-once",
                    "fixture-ui",
                  );
                }
                reply = await pending.completion;
              } else {
                reply = pending.reply;
              }
              expect(engine.getPendingOperatorProposal()).toBeNull();
              // Duplicate approval delivery cannot replay or allocate a second agent.
              expect(await engine.resolveOperatorApproval("allow-once", proposal.hash)).toBeNull();
              const stored = (await readConfigFileSnapshot()).config;
              if (succeeds) {
                expect(reply.applied).toBe(true);
                expect(reply.text).toContain('"status":"complete"');
                expect(reply.text).toContain(stored.agents?.entries?.[agentId]?.workspace);
                expect(
                  await fs.readFile(
                    path.join(stored.agents!.entries![agentId]!.workspace!, "SOUL.md"),
                    "utf8",
                  ),
                ).toContain("Only fixture instructions.");
                expect(greeting).toHaveBeenCalledOnce();
                const retry = await engine.handle("Retry the same Template installation");
                expect(retry.applied).not.toBe(true);
                expect(engine.getPendingOperatorProposal()).toBeNull();
                expect(
                  Object.keys((await readConfigFileSnapshot()).config.agents!.entries!),
                ).toEqual(["main", agentId]);
              } else {
                expect(reply.applied).not.toBe(true);
                expect(stored.agents?.entries?.[agentId]).toBeUndefined();
                expect(greeting).not.toHaveBeenCalled();
              }
            });
          } finally {
            await engine.dispose();
            releaseAgentRunDelegatedAuthority(authority);
          }
        }, config);
      } finally {
        unsubscribe();
      }
    });
  },
);
