import type { Locator } from "playwright";
import { expect } from "vitest";
import type { ModelCatalogEntry } from "../api/types.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { SESSION_LIST_DEFAULTS } from "./new-session-page.test-support.ts";

export function sessionList(...sessions: Record<string, unknown>[]) {
  return {
    count: sessions.length,
    defaults: SESSION_LIST_DEFAULTS,
    path: "",
    ts: Date.now(),
    sessions,
  };
}

export async function expectRequest(gateway: MockGatewayControls, method: string, params: object) {
  expect((await gateway.waitForRequest(method)).params).toMatchObject(params);
}

export const pollVisible = (target: Locator) => expect.poll(() => target.isVisible());
export const pollFocused = (target: Locator) =>
  expect.poll(() => target.evaluate((element) => element === document.activeElement));
export const pollOpacity = (target: Locator) =>
  expect.poll(() => target.evaluate((element) => getComputedStyle(element).opacity));

export function personalModelScenario(
  model: ModelCatalogEntry,
  account: {
    authProfileId: string;
    provider: string;
    label: string;
    authType: string;
    selected: boolean;
  },
  preview: { commands: never[] } | { refreshFailed: boolean },
) {
  const unavailable: ModelCatalogEntry = {
    ...model,
    available: false,
    unavailableReason: "missing-auth",
  };
  return {
    agentModel: `${model.provider}/${model.id}`,
    presenceUsers: [{ id: "person-a", name: "Test Person", self: true }],
    models: [unavailable],
    methodResponses: {
      "users.listModelAccounts": { profileId: "person-a", accounts: [account], links: [] },
      "models.list": {
        cases: [
          {
            match: { authProfileId: account.authProfileId },
            response: {
              ...preview,
              models: [{ ...model, available: true }],
              accountSelection: {
                kind: "personal",
                authProfileId: account.authProfileId,
                label: account.label,
                source: "user",
              },
            },
          },
          {
            match: {},
            response: {
              commands: [],
              models: [unavailable],
              accountSelection: { kind: "automatic", label: "Automatic" },
            },
          },
        ],
      },
    },
  };
}

export function environmentProfiles(...ids: string[]) {
  return { environments: [], profiles: ids.map((id) => ({ id, providerId: "crabbox" })) };
}

export function unavailableError(message: string) {
  return { code: "UNAVAILABLE", message };
}
