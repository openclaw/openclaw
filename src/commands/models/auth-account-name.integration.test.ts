import { expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { upsertAuthProfileAsync } from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

const { resolvePluginProvidersCore } = vi.hoisted(() => ({ resolvePluginProvidersCore: vi.fn() }));
vi.mock("../../plugins/providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.runtime.js")>()),
  resolvePluginProvidersCore,
}));
vi.mock("./auth-refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-refresh.js")>()),
  refreshProviderAuthAfterLogin: async () => "refreshed",
  refreshRunningGatewayAuthState: async () => "gateway-unreachable",
}));

const provider = "account-name-fixture";
const personal = `${provider}:personal`;
const work = `${provider}:work`;
const explicit = `${provider}:explicit`;
const email = "person@example.invalid";
function credential(accountId: string, access: string): OAuthCredential {
  return {
    type: "oauth",
    provider,
    accountId,
    access,
    refresh: "fixture-refresh",
    expires: 2_000_000_000_000,
    email,
  };
}

it.each([
  { scenario: "first account", first: true, offer: false },
  { scenario: "added account", offer: true, name: "Work" },
  { scenario: "keep the existing email as default", offer: true, answer: email },
  {
    scenario: "save an accepted suggestion when the profile has no label",
    offer: true,
    noEmail: true,
    answer: "Example",
    name: "Example",
  },
  { scenario: "chat without optional text", offer: false, chat: true },
  { scenario: "reconnect", offer: false, reconnect: true, name: "Existing work name" },
  {
    scenario: "forced reconnect",
    offer: false,
    reconnect: true,
    force: true,
    name: "Existing work name",
  },
  { scenario: "added explicit profile", offer: true, explicit: true, name: "Work" },
  { scenario: "cancel the name without losing the account", offer: true, cancel: true },
  { scenario: "failed name prompt leaves the account saved", offer: true, promptError: true },
])("keeps sign-in and labeling independent: $scenario", async (test) => {
  await withOpenClawTestState({ label: "models-auth-account-name" }, async (state) => {
    await state.writeConfig({
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: { modelPolicy: { allow: [`${provider}/*`] } },
      },
      plugins: { enabled: false },
    });
    const readStore = () => loadAuthProfileStoreWithoutExternalProfilesAsync();
    if (!test.first) {
      await upsertAuthProfileAsync({
        profileId: personal,
        credential: credential("personal", "personal-access"),
      });
    }
    if (test.reconnect) {
      await upsertAuthProfileAsync({
        profileId: work,
        credential: { ...credential("work", "old-access"), displayName: "Existing work name" },
      });
    }
    const inputId = test.reconnect ? `${provider}:provider-chosen-id` : work;
    const savedId = test.explicit ? explicit : work;
    const plugin: ProviderPlugin = {
      id: provider,
      label: "Example",
      auth: [
        {
          id: "oauth",
          label: "Example login",
          kind: "oauth",
          matchesPersonalAccount: (next, previous) =>
            next.type === "oauth" &&
            previous.type === "oauth" &&
            next.provider === previous.provider &&
            next.accountId === previous.accountId,
          run: async () => ({
            profiles: [
              {
                profileId: inputId,
                credential: {
                  ...credential("work", "new-access"),
                  ...(test.noEmail ? { email: undefined } : {}),
                },
              },
            ],
          }),
        },
      ],
    };
    resolvePluginProvidersCore.mockReturnValue([plugin]);
    let credentialWasSavedDuringPrompt = false;
    const text = vi.fn(async () => {
      credentialWasSavedDuringPrompt = (await readStore()).profiles[savedId]?.type === "oauth";
      if (test.cancel || test.chat) {
        throw new WizardCancelledError();
      }
      if (test.promptError) {
        throw new Error("Synthetic terminal input failure");
      }
      return test.answer ?? " Work ";
    });
    const prompter = {
      ...createWizardPrompter({ text }),
      ...(!test.chat ? { optionalText: text } : {}),
    };
    await expect(
      runModelsAuthLoginFlowCore({
        provider,
        prompter,
        credentialOnly: true,
        ...(test.force ? { force: true } : {}),
        ...(test.explicit ? { profileId: explicit } : {}),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      }),
    ).resolves.toMatchObject({ profiles: [{ profileId: savedId }] });

    expect(text).toHaveBeenCalledTimes(test.offer ? 1 : 0);
    if (test.offer) {
      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ initialValue: test.noEmail ? "Example" : email }),
      );
      expect(credentialWasSavedDuringPrompt).toBe(true);
    }
    const saved = (await readStore()).profiles[savedId];
    expect(saved).toMatchObject({ type: "oauth", access: "new-access" });
    expect(saved?.displayName).toBe(test.name);
  });
});
