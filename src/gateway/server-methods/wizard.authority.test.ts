import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { WizardSession } from "../../wizard/session.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import {
  createAdmittedWizardSession,
  startGatewayWizard,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";

it.each(["admission", "publication"])(
  "releases login setup when its connection closes before %s",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const connection = new AbortController();
      const client = createOperatorClient({
        profileId: "login-owner",
        scopes: ["operator.admin"],
      });
      client.connectionSignal = connection.signal;
      const context = createContext();
      Object.assign(context, createWizardSessionTracker());
      const respond = vi.fn();
      const createSession = vi.fn(() => {
        if (phase === "publication") {
          connection.abort(new Error("Connection closed before publication"));
        }
        return new WizardSession(async (prompter) => {
          await prompter.confirm({ message: "Continue setup?" });
        });
      });
      if (phase === "admission") {
        connection.abort(new Error("Connection closed before admission"));
      }
      const params = { sessionId: "disconnected-login" };
      const start = startGatewayWizard({
        request: {
          req: { type: "req", id: "login", method: "models.authLogin", params },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
        },
        ...params,
        connectionBound: true,
        createSession,
      });
      if (phase === "admission") {
        await expect(start).rejects.toThrow("Connection closed before admission");
        expect(createSession).not.toHaveBeenCalled();
      } else {
        await start;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: "Setup is no longer available on this connection.",
          }),
        );
      }
      expect(context.wizardSessions.size).toBe(0);
      const replacement = expectDefined(
        await createAdmittedWizardSession(() => new WizardSession(async () => {})),
        "replacement setup admission",
      );
      await whenAdmittedWizardSessionSettled(replacement);
    });
  },
);

it("publishes a wizard that completed before its start reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const client = createOperatorClient({ profileId: "fast-owner", scopes: ["operator.admin"] });
    const context = createContext();
    Object.assign(context, createWizardSessionTracker());
    const respond = vi.fn();
    const params = { sessionId: "fast-setup" };
    await startGatewayWizard({
      request: {
        req: { type: "req", id: "fast", method: "openclaw.setup.prepare.start", params },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      },
      ...params,
      admit: async (create) => {
        const session = await createAdmittedWizardSession(create);
        await whenAdmittedWizardSessionSettled(expectDefined(session, "fast session"));
        return session;
      },
      createSession: () => new WizardSession(async () => {}),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { sessionId: "fast-setup", done: false, status: "running" },
      undefined,
    );
    const session = expectDefined(context.wizardSessions.get("fast-setup"), "fast session");
    expect(await session.next()).toMatchObject({ done: true, status: "done" });
  });
});
