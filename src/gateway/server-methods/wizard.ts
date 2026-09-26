import { randomUUID } from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateWizardCancelParams,
  validateWizardNextParams,
  validateWizardStartParams,
  validateWizardStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OnboardOptions } from "../../commands/onboard-types.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createNonExitingRuntime, ExitError, type RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  sanitizeWizardStepForClient,
  WizardSession,
  type WizardStep,
} from "../../wizard/session.js";
import { canAccessWizardSession } from "../server-wizard-sessions.js";
import { formatForLog } from "../ws-log.js";
import {
  createAdmittedWizardSession,
  respondSetupAdmissionBusy,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler, type Validator } from "./validation.js";

export type SetupWizardRunner = (
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export type ChannelSetupWizardRunner = (
  opts: {
    channel?: string;
    onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
    beforePersistentEffect?: () => Promise<void>;
    assertPersistentEffectCurrent?: () => void;
  },
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../../wizard/setup.js");
  return runSetupWizard(...args);
};

export const runDefaultChannelSetupWizard: ChannelSetupWizardRunner = async (...args) => {
  const { runChannelsSetupWizard } = await import("../../commands/channels/add-wizard.js");
  return runChannelsSetupWizard(...args);
};

async function runHostedWizard(run: (runtime: RuntimeEnv) => Promise<void>): Promise<void> {
  await using cache = createPluginCache();
  try {
    await runOutsidePluginRuntimeGenerationScope(() =>
      withPluginCache(cache, () => run(createNonExitingRuntime())),
    );
  } catch (error) {
    // Hosted wizards share the Gateway process; a successful CLI-style exit
    // must complete only its session, while failures remain session errors.
    if (error instanceof ExitError && error.code === 0) {
      return;
    }
    throw error;
  }
}

function readWizardStatus(session: WizardSession) {
  return {
    status: session.getStatus(),
    error: session.getError(),
  };
}

function sanitizeWizardResultForClient<T extends { step?: WizardStep }>(result: T): T {
  return result.step ? { ...result, step: sanitizeWizardStepForClient(result.step) } : result;
}

function wizardSessionHandler<T extends { sessionId: string }>(
  method: string,
  validate: Validator<T>,
  run: (
    options: Omit<GatewayRequestHandlerOptions, "params"> & { params: T },
    session: WizardSession,
  ) => Promise<void>,
) {
  return defineValidatedGatewayHandler(method, validate, async (options) => {
    const session = options.context.wizardSessions.get(options.params.sessionId);
    if (!session || !canAccessWizardSession(session, options.client)) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found", {
          details: { code: GatewayErrorDetailCodes.WIZARD_NOT_FOUND },
        }),
      );
      return;
    }
    await run(options, session);
  });
}

export const wizardHandlers: GatewayRequestHandlers = {
  "wizard.start": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) {
      return;
    }
    const sessionId = randomUUID();
    const flow = params.flow ?? "setup";
    const createSession = () =>
      flow === "channels"
        ? new WizardSession((prompter, _signal, wizardSession) =>
            runHostedWizard((runtime) =>
              context.channelWizardRunner(
                {
                  channel: readStringValue(params.channel),
                  onConfigured: (accounts) => wizardSession.setConfiguredAccounts(accounts),
                  // Durable effects (plugin installs, config commit) must finish
                  // even if the client cancels mid-write.
                  beforePersistentEffect: async () => wizardSession.lockCancellation(),
                  assertPersistentEffectCurrent: () =>
                    wizardSession.assertPersistentEffectCurrent(),
                },
                runtime,
                prompter,
              ),
            ),
          )
        : new WizardSession((prompter) =>
            runHostedWizard((runtime) =>
              context.wizardRunner(
                {
                  mode: params.mode,
                  workspace: readStringValue(params.workspace),
                  installDaemon: params.installDaemon,
                },
                runtime,
                prompter,
              ),
            ),
          );
    const session = await createAdmittedWizardSession(createSession, flow === "setup");
    if (!session) {
      respondSetupAdmissionBusy(respond);
      return;
    }
    context.wizardSessions.set(sessionId, session);
    const result = await session.next();
    if (result.done) {
      // Let the runner release setup admission before the terminal response,
      // so an immediate replacement wizard is not rejected as still busy.
      await whenAdmittedWizardSessionSettled(session);
      context.purgeWizardSession(sessionId);
    }
    respond(true, { sessionId, ...sanitizeWizardResultForClient(result) }, undefined);
  },
  "wizard.next": wizardSessionHandler(
    "wizard.next",
    validateWizardNextParams,
    async ({ params, respond, context }, session) => {
      const { sessionId } = params;
      const answer = params.answer;
      if (answer) {
        if (session.getStatus() !== "running") {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
          return;
        }
        try {
          const validationError = await session.answer(answer.stepId ?? "", answer.value);
          if (validationError) {
            respond(
              true,
              {
                ...sanitizeWizardResultForClient(await session.next()),
                error: validationError,
              },
              undefined,
            );
            return;
          }
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
          return;
        }
      }
      const result = await session.next();
      if (result.done) {
        // Keep terminal response ordering identical to wizard.start.
        await whenAdmittedWizardSessionSettled(session);
        context.purgeWizardSession(sessionId);
      }
      respond(true, sanitizeWizardResultForClient(result), undefined);
    },
  ),
  "wizard.cancel": wizardSessionHandler(
    "wizard.cancel",
    validateWizardCancelParams,
    async ({ params, respond, context }, session) => {
      const { sessionId } = params;
      if (params.closeInput) {
        session.close(new Error("The setup window was closed."));
        await whenAdmittedWizardSessionSettled(session);
        const status = readWizardStatus(session);
        context.purgeWizardSession(sessionId);
        respond(true, status, undefined);
        return;
      }
      const cancelled = session.cancel();
      const status = readWizardStatus(session);
      if (cancelled || status.status !== "running") {
        const purge = () => context.purgeWizardSession(sessionId);
        void whenAdmittedWizardSessionSettled(session).then(purge, purge);
      }
      respond(true, status, undefined);
    },
  ),
  "wizard.status": wizardSessionHandler(
    "wizard.status",
    validateWizardStatusParams,
    async ({ params, respond, context }, session) => {
      const { sessionId } = params;
      const status = readWizardStatus(session);
      if (status.status !== "running") {
        await whenAdmittedWizardSessionSettled(session);
      }
      context.purgeWizardSession(sessionId);
      respond(true, status, undefined);
    },
  ),
};
