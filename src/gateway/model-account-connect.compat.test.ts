import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { ProviderAuthMethod } from "../plugins/provider-authentication.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  connectUserModelAccount,
  listUserProfileAuthLinks,
  readUserModelAuthProfile,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { WizardSession } from "../wizard/session.js";
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
} from "./model-account-connect-errors.js";
import { createModelAccountConnectService } from "./model-account-connect.js";

const resolveMethod = vi.hoisted(() => vi.fn());
vi.mock("../plugins/personal-account-auth.js", () => ({
  listPersonalAccountAuthChoices: () => [],
  resolvePersonalAccountAuthMethod: resolveMethod,
}));

afterEach(() => vi.restoreAllMocks());

it("keeps released account methods synchronous with immediate persistence and current owner authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("compat-owner@example.test").id;
    const other = {
      owner: ensureProfileForEmail("compat-other@example.test").id,
      assertCurrent() {},
    };
    let live = true;
    const action = {
      owner,
      assertCurrent() {
        if (!live) {
          throw new ModelAccountConnectAuthorityError();
        }
      },
    };
    const credential = {
      type: "token" as const,
      provider: "synthetic",
      token: "synthetic-compat-token",
    };
    const first = connectUserModelAccount({
      ownerProfileId: owner,
      credential,
      assertCurrent() {},
    }).authProfileId;
    const second = connectUserModelAccount({
      ownerProfileId: owner,
      credential,
      assertCurrent() {},
    }).authProfileId;
    const service = createModelAccountConnectService({ getConfig: () => ({}) });
    try {
      expect(service.listLinks(action)).toMatchObject({
        links: [{ provider: "synthetic", authProfileId: second }],
      });
      expect(service.unlink(action, "synthetic")).toEqual({ links: [] });
      expect(listUserProfileAuthLinks(owner)).toEqual([]);
      expect(service.link(action, first)).toMatchObject({
        links: [{ provider: "synthetic", authProfileId: first }],
      });
      expect(listUserProfileAuthLinks(owner)).toMatchObject([{ authProfileId: first }]);
      expect(service.select(action, second)).toMatchObject({
        links: [{ provider: "synthetic", authProfileId: second }],
      });
      expect(listUserProfileAuthLinks(owner)).toMatchObject([{ authProfileId: second }]);
      const inventory = service.list(action);
      expect(inventory).toMatchObject({
        profileId: owner,
        accounts: expect.arrayContaining([
          expect.objectContaining({ authProfileId: first, selected: false }),
          expect.objectContaining({ authProfileId: second, selected: true }),
        ]),
        links: [{ provider: "synthetic", authProfileId: second }],
      });
      expect(JSON.stringify(inventory)).not.toContain(credential.token);
      expect(readUserModelAuthProfile(first)?.credential).toEqual(credential);
      expect(service.list(other)).toEqual({ profileId: other.owner, accounts: [], links: [] });
      expect(() => service.link(other, first)).toThrow(ModelAccountConnectInputError);
      expect(() => service.select(other, first)).toThrow(ModelAccountConnectInputError);
      expect(listUserProfileAuthLinks(other.owner)).toEqual([]);
      expect(service.status(action, "missing-connect")).toEqual({ status: "expired" });
      expect(service.cancel(action, "missing-connect")).toEqual({ status: "expired" });

      live = false;
      for (const invoke of [
        () => service.listLinks(action),
        () => service.link(action, first),
        () => service.unlink(action, "synthetic"),
        () => service.list(action),
        () => service.select(action, first),
        () => service.status(action, "missing-connect"),
        () => service.cancel(action, "missing-connect"),
      ]) {
        expect(invoke).toThrow(ModelAccountConnectAuthorityError);
      }
      expect(listUserProfileAuthLinks(owner)).toMatchObject([{ authProfileId: second }]);
    } finally {
      await service.stop();
    }
  });
});

it("returns pending, cancelled, expired and connected sign-in results synchronously without disclosing another owner's operation", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const action = {
      owner: ensureProfileForEmail("compat-signin@example.test").id,
      assertCurrent() {},
    };
    const other = {
      owner: ensureProfileForEmail("compat-stranger@example.test").id,
      assertCurrent() {},
    };
    let prompted = createDeferredCore();
    let settled = createDeferredCore();
    const connected = createDeferredCore();
    const method: ProviderAuthMethod = {
      id: "token",
      label: "Synthetic token",
      kind: "token",
      async run(context) {
        const answer = context.prompter.text({ message: "Synthetic token", sensitive: true });
        prompted.resolve();
        const token = await answer;
        return {
          profiles: [
            {
              profileId: "ignored-shared-id",
              credential: { type: "token", provider: "synthetic", token },
            },
          ],
        };
      },
    };
    resolveMethod.mockResolvedValue(method);
    // oxlint-disable-next-line typescript/unbound-method -- Called with the observed real Wizard receiver.
    const cancel = WizardSession.prototype.cancel;
    const cancellation = vi.spyOn(WizardSession.prototype, "cancel").mockImplementation(function (
      this: WizardSession,
    ) {
      settled.resolve(this.whenSettled());
      return cancel.call(this);
    });
    const service = createModelAccountConnectService({
      getConfig: () => ({}),
      onChanged: connected.resolve,
    });
    const waitFor = (gate: Promise<void>) =>
      withinTest(
        awaitGateBeforeSettlement(
          gate,
          settled.promise,
          "Personal sign-in settled before reaching its client checkpoint",
        ),
        signal,
      );
    const startPending = async () => {
      prompted = createDeferredCore();
      settled = createDeferredCore();
      const flow = await service.start(action, "synthetic", "token");
      await waitFor(prompted.promise);
      const pending = service.status(action, flow.connectId);
      expect(pending).toMatchObject({ status: "pending", step: { type: "text", sensitive: true } });
      if (pending.status !== "pending" || !pending.step) {
        throw new Error("Expected a synchronous pending sign-in step");
      }
      return { ...flow, stepId: pending.step.id };
    };
    try {
      const cancelled = await startPending();
      expect(service.status(other, cancelled.connectId)).toEqual({ status: "expired" });
      expect(service.cancel(other, cancelled.connectId)).toEqual({ status: "expired" });
      expect(service.status(action, cancelled.connectId)).toMatchObject({ status: "pending" });
      expect(service.cancel(action, cancelled.connectId)).toEqual({ status: "cancelled" });
      await withinTest(settled.promise, signal);
      expect(service.status(action, cancelled.connectId)).toEqual({ status: "cancelled" });
      expect(listUserProfileAuthLinks(action.owner)).toEqual([]);

      const expired = await startPending();
      const clock = vi.spyOn(Date, "now").mockReturnValue(expired.expiresAtMs + 1);
      try {
        expect(service.status(action, expired.connectId)).toEqual({ status: "expired" });
        expect(service.cancel(action, expired.connectId)).toEqual({ status: "expired" });
      } finally {
        clock.mockRestore();
      }
      await withinTest(settled.promise, signal);

      const successful = await startPending();
      await service.answer(
        action,
        successful.connectId,
        successful.stepId,
        "synthetic-compat-signin-token",
      );
      await waitFor(connected.promise);
      await withinTest(settled.promise, signal);
      const result = service.status(action, successful.connectId);
      expect(result).toMatchObject({
        status: "connected",
        authProfileId: expect.any(String),
        links: [{ provider: "synthetic" }],
      });
      if (result.status !== "connected") {
        throw new Error("Expected a synchronous connected account result");
      }
      expect(readUserModelAuthProfile(result.authProfileId)?.credential).toEqual({
        type: "token",
        provider: "synthetic",
        token: "synthetic-compat-signin-token",
      });
      expect(service.unlink(action, "synthetic")).toEqual({ links: [] });
      const replay = { status: "connected", authProfileId: result.authProfileId, links: [] };
      expect(service.status(action, successful.connectId)).toEqual(replay);
      expect(service.cancel(action, successful.connectId)).toEqual(replay);
      expect(service.status(other, successful.connectId)).toEqual({ status: "expired" });
      expect(JSON.stringify(result)).not.toContain("synthetic-compat-signin-token");
    } finally {
      await service.stop();
      cancellation.mockRestore();
    }
  });
});
