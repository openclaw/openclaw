import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runSetupInferenceTurn } from "../../system-agent/setup-inference-turn.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { wizardHandlers } from "./wizard.js";

it.each([
  { revoked: false, progress: false },
  { revoked: false, progress: true },
  { revoked: true, progress: true },
])(
  "runs the post-start setup-inference probe under wizard.next authority (revoked=$revoked, progress=$progress)",
  async ({ revoked, progress }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const client = createOperatorClient({
        profileName: "wizard-authority",
        scopes: ["operator.admin"],
      });
      const context = createContext();
      Object.assign(context, createWizardSessionTracker());
      const connection = new AbortController();
      const continueProbe = createDeferredCore();
      let captureError: unknown;
      let probe: Awaited<ReturnType<typeof runSetupInferenceTurn>> | undefined;
      context.wizardRunner = async (_opts, _runtime, prompter) => {
        await prompter.confirm({ message: "Verify saved sign-in?" });
        if (progress) {
          prompter.progress("Checking saved sign-in");
          await continueProbe.promise;
        }
        const config = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
        probe = await runSetupInferenceTurn({
          requireExecutionOwner: false,
          route: {
            runner: "embedded",
            provider: "openai",
            model: "gpt-5.6-sol",
            modelLabel: "openai/gpt-5.6-sol",
            agentId: "main",
            agentDir: state.agentDir(),
            sourceConfig: config,
            runConfig: config,
          },
          deps: {
            createTempDir: async () => state.workspaceDir,
            removeTempDir: async () => {},
            runEmbeddedAgent: async () => {
              if (revoked) {
                invalidateGatewayDeviceRevocation(context, "wizard-device", "operator");
              }
              const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "probe scope");
              try {
                const captured = expectDefined(
                  await captureGatewayOperatorRunAuthority({
                    client: scope.client ?? null,
                    context,
                    hasCurrentClientAuthority: scope.hasCurrentClientAuthority,
                  }),
                  "probe operator authority",
                );
                try {
                  captured.authority.assertCurrent();
                } finally {
                  captured.release();
                }
              } catch (error) {
                captureError = error;
                console.info("setup-inference authority capture:", error);
                throw error;
              }
              return {
                payloads: [{ text: "OK" }],
                meta: {
                  durationMs: 1,
                  executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.6-sol" },
                },
              };
            },
          },
        });
        if (!probe.ok) {
          throw new Error(probe.error);
        }
      };

      async function request(
        method: "wizard.start" | "wizard.next",
        params: Record<string, unknown>,
      ) {
        const authority = captureGatewayDeviceRevocation(
          context,
          { deviceId: "wizard-device", role: "operator" },
          () => true,
          connection.signal,
        );
        const respond = vi.fn();
        const options: GatewayRequestHandlerOptions = {
          req: { type: "req", id: method, method, params },
          params,
          respond,
          context,
          client,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: authority.isCurrent,
        };
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              isWebchatConnect: () => false,
              hasCurrentClientAuthority: authority.isCurrent,
            },
            () => expectDefined(wizardHandlers[method], method)(options),
          );
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return respond.mock.calls[0]?.[1] as {
            sessionId: string;
            step: { id: string };
            status: string;
            error?: string;
          };
        } finally {
          authority.release();
        }
      }

      const start = await request("wizard.start", { mode: "local" });
      expect(start.status).toBe("running");
      const session = expectDefined(context.wizardSessions.get(start.sessionId), "wizard session");
      try {
        let result = await request("wizard.next", {
          sessionId: start.sessionId,
          answer: { stepId: start.step.id, value: true },
        });
        if (progress) {
          expect(result).toMatchObject({ status: "running", step: { type: "progress" } });
          continueProbe.resolve();
          result = await request("wizard.next", { sessionId: start.sessionId });
        }
        if (revoked) {
          expect(result.status).toBe("error");
          expect(captureError).toMatchObject({
            message: "Gateway caller authority is no longer active.",
          });
          expect(probe).toMatchObject({ ok: false });
        } else {
          expect(result.error).toBeUndefined();
          expect(result).toMatchObject({ status: "done" });
          expect(probe).toMatchObject({ ok: true, text: "OK" });
        }
      } finally {
        continueProbe.resolve();
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    });
  },
);
