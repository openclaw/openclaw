// Wizard server-method tests cover stable lifecycle errors for process-local sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OnboardOptions } from "../../commands/onboard-types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { type SetupWizardRunner, wizardHandlers } from "./wizard.js";

type WizardFlow = "setup" | "channels";

type ProjectedOptions = Pick<
  OnboardOptions,
  "installDaemon" | "skipUi" | "suppressGatewayTokenOutput"
>;

type WizardResult = {
  sessionId: string;
  done: boolean;
  status: "running" | "done" | "cancelled" | "error";
  step?: { id: string };
  error?: string;
};

function responsePayload(respond: ReturnType<typeof vi.fn>): WizardResult {
  expect(respond).toHaveBeenCalledOnce();
  const [ok, payload, error] = respond.mock.calls[0] ?? [];
  expect(ok).toBe(true);
  expect(error).toBeUndefined();
  return payload as WizardResult;
}

async function runWizardExit(flow: WizardFlow, exitCode: number): Promise<WizardResult> {
  const tracker = createWizardSessionTracker();
  const runner = async (runtime: RuntimeEnv, prompter: WizardPrompter) => {
    await prompter.outro(exitCode === 0 ? "complete" : "invalid configuration");
    runtime.exit(exitCode);
  };
  const context = {
    ...tracker,
    wizardRunner: async (_opts: unknown, runtime: RuntimeEnv, prompter: WizardPrompter) =>
      runner(runtime, prompter),
    channelWizardRunner: async (_opts: unknown, runtime: RuntimeEnv, prompter: WizardPrompter) =>
      runner(runtime, prompter),
  };
  const startRespond = vi.fn();
  await expectDefined(
    wizardHandlers["wizard.start"],
    "wizard.start test invariant",
  )({
    params: flow === "channels" ? { flow } : { mode: "local" },
    respond: startRespond,
    context,
  } as never);
  const start = responsePayload(startRespond);
  expect(start).toMatchObject({ done: false, status: "running" });
  expect(start.step?.id).toBeTruthy();

  const nextRespond = vi.fn();
  await expectDefined(
    wizardHandlers["wizard.next"],
    "wizard.next test invariant",
  )({
    params: {
      sessionId: start.sessionId,
      answer: { stepId: start.step?.id, value: null },
    },
    respond: nextRespond,
    context,
  } as never);
  return responsePayload(nextRespond);
}

describe("wizard session lookup", () => {
  it.each([
    { method: "wizard.next", params: { sessionId: "expired" } },
    { method: "wizard.cancel", params: { sessionId: "expired" } },
    { method: "wizard.status", params: { sessionId: "expired" } },
  ] as const)("returns structured details from $method", async ({ method, params }) => {
    const respond = vi.fn();
    const handler = expectDefined(
      wizardHandlers[method],
      `wizardHandlers[${method}] test invariant`,
    );

    await handler({
      req: { type: "req", id: "wizard-missing", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { wizardSessions: new Map() } as never,
    } as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    });
  });
});

describe("wizard gateway runtime", () => {
  it.each<WizardFlow>(["setup", "channels"])(
    "keeps the gateway alive when the %s wizard exits successfully",
    async (flow) => {
      await expect(runWizardExit(flow, 0)).resolves.toMatchObject({
        done: true,
        status: "done",
        error: undefined,
      });
    },
  );

  it.each<WizardFlow>(["setup", "channels"])(
    "reports a non-zero %s wizard exit as a session error",
    async (flow) => {
      const result = await runWizardExit(flow, 1);
      expect(result).toMatchObject({ done: true, status: "error" });
      expect(result.error).toContain("exit 1");
    },
  );
});

describe("wizard setup ownership", () => {
  it.each([
    { label: "false", params: { installDaemon: false }, expected: false },
    { label: "true", params: { installDaemon: true }, expected: true },
    { label: "omitted", params: {}, expected: undefined },
  ])("projects installDaemon when $label", async ({ params, expected }) => {
    let receivedOptions: ProjectedOptions | undefined;
    const tracker = createWizardSessionTracker();
    const wizardRunner: SetupWizardRunner = async (opts, _runtime, prompter) => {
      receivedOptions = {
        installDaemon: opts.installDaemon,
        skipUi: opts.skipUi,
        suppressGatewayTokenOutput: opts.suppressGatewayTokenOutput,
      };
      await prompter.note("ready");
    };
    const context = {
      ...tracker,
      wizardRunner,
    };
    const respond = vi.fn();

    await expectDefined(
      wizardHandlers["wizard.start"],
      "wizard.start test invariant",
    )({
      params: { mode: "local", ...params },
      respond,
      context,
    } as never);

    expect(receivedOptions).toEqual({
      installDaemon: expected,
      skipUi: true,
      suppressGatewayTokenOutput: true,
    });
    expect(responsePayload(respond)).toMatchObject({ done: false, status: "running" });

    for (const session of tracker.wizardSessions.values()) {
      session.cancel();
    }
  });
});
