import { describe, expect, it, vi } from "vitest";
import type { OnboardOptions } from "../../commands/onboard-types.js";
import type { WizardSession } from "../../wizard/session.js";
import { type SetupWizardRunner, wizardHandlers } from "./wizard.js";

type ProjectedOptions = Pick<
  OnboardOptions,
  "installDaemon" | "skipUi" | "suppressGatewayTokenOutput"
>;

describe("wizard.start", () => {
  it.each([
    { label: "false", params: { installDaemon: false }, expected: false },
    { label: "true", params: { installDaemon: true }, expected: true },
    { label: "omitted", params: {}, expected: undefined },
  ])("projects installDaemon when $label", async ({ params, expected }) => {
    let receivedOptions: ProjectedOptions | undefined;
    const wizardSessions = new Map<string, WizardSession>();
    const respond = vi.fn();
    const wizardRunner: SetupWizardRunner = async (opts, _runtime, prompter) => {
      receivedOptions = {
        installDaemon: opts.installDaemon,
        skipUi: opts.skipUi,
        suppressGatewayTokenOutput: opts.suppressGatewayTokenOutput,
      };
      await prompter.note("ready");
    };
    const context = {
      findRunningWizard: () => null,
      wizardSessions,
      purgeWizardSession: vi.fn(),
      wizardRunner,
    };

    const startWizard = wizardHandlers["wizard.start"];
    if (!startWizard) {
      throw new Error("wizard.start handler is not registered");
    }

    await startWizard({
      params: { mode: "local", ...params },
      respond,
      context,
    } as never);

    expect(receivedOptions).toEqual({
      installDaemon: expected,
      skipUi: true,
      suppressGatewayTokenOutput: true,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ done: false, status: "running" }),
      undefined,
    );

    for (const session of wizardSessions.values()) {
      session.cancel();
    }
  });
});
