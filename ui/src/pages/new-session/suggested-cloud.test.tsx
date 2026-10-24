/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { createMemo, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { draftWhereChipParams, resolveWhereChip } from "./where-chip.ts";
import { WhereChip } from "./where-chip.tsx";

const suggestedProfile = { id: "cloud", providerId: "crabbox", providerDisplayId: "aws" };
const profile = { ...suggestedProfile, executionModes: ["worker-turn"] };
const emptyCatalog = () => ({ environments: [], profiles: [], suggestedProfile });

async function fixture(onChange?: () => void) {
  const adoption = Promise.withResolvers<unknown>();
  let saved = false;
  const result = createDraftFixture({
    onChange,
    methods: [
      "environments.list",
      "environments.adoptSuggestedProfile",
      "sessions.create",
      "sessions.dispatch",
    ],
    scopes: ["operator.admin", "operator.read", "operator.write"],
    request: async (method) => {
      if (method === "environments.list") {
        return saved ? { environments: [], profiles: [profile] } : emptyCatalog();
      }
      if (method === "environments.adoptSuggestedProfile") {
        const response = await adoption.promise;
        saved = true;
        return response;
      }
      return {};
    },
  });
  await result.gateway.refreshCloudProfiles();
  return { ...result, adoption };
}

afterEach(() => [sessionStorage, localStorage].forEach((storage) => storage.clear()));

it.each([
  ["successful save", "cloud", [profile], undefined, null],
  ["save failure", "", [], suggestedProfile, "Crabbox login expired"],
  ["local reselection", "", [profile], undefined, null],
  ["Gateway reconnection", "", [], undefined, null],
] as const)(
  "settles suggested Cloud adoption after %s without dispatching or replacing newer intent",
  async (outcome, cloudProfileId, cloudProfiles, suggestion, error) => {
    const { place, gateway, flow, request, adoption, context } = await fixture();
    flow.setMessage("Prepare this repository");
    const selecting = place.suggestedCloudProfile.adopt();
    expect(place.cloudProfileId).toBe("");
    expect(flow.submitBlock()?.gate).toBe("cloud");
    expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
    if (outcome === "local reselection") {
      place.selectDevice("");
    }
    if (outcome === "Gateway reconnection") {
      context.gateway.snapshot.phase = "connecting";
      gateway.synchronize(context.gateway);
      place.invalidateGatewayDiscovery(true);
    }
    adoption.resolve(error ? Promise.reject(new Error(error)) : { profile });
    await selecting;
    expect(place).toMatchObject({
      cloudProfileId,
      suggestedCloudProfile: { pending: false },
    });
    expect(gateway).toMatchObject({ cloudProfiles, suggestedProfile: suggestion });
    expect(flow.error).toBe(error);
  },
);

it("keeps the adopted profile when an older catalog read finishes", async () => {
  const { place, gateway, request, adoption } = await fixture();
  const staleCatalog = Promise.withResolvers<unknown>();
  request.mockImplementationOnce((method) => {
    expect(method).toBe("environments.list");
    return staleCatalog.promise;
  });
  const refreshing = gateway.refreshCloudProfiles();
  const selecting = place.suggestedCloudProfile.adopt();
  adoption.resolve({ profile });
  await selecting;
  staleCatalog.resolve(emptyCatalog());
  await refreshing;
  expect(place.cloudProfileId).toBe("cloud");
  expect(gateway).toMatchObject({ cloudProfiles: [{ id: "cloud" }], suggestedProfile: undefined });
});

async function renderedFixture() {
  let publish = () => {};
  const result = await fixture(() => publish());
  result.place.browser.popoverCallbacks("where").onPopoverShow();
  const mounted = mountSolid(() => {
    const [revision, setRevision] = createSignal(0);
    publish = () => setRevision((value) => value + 1);
    const params = createMemo(() => {
      revision();
      return {
        context: result.context,
        data: undefined,
        place: result.place,
        gateway: result.gateway,
        submitting: result.flow.submitting,
        pendingPlacement: Boolean(result.flow.pendingPlacement.sessionKey),
        onConnectMachine: vi.fn(),
        onNavigate: vi.fn(),
        onFocusComposer: vi.fn(),
        onChange: publish,
      };
    });
    const state = createMemo(() => {
      revision();
      return resolveWhereChip(draftWhereChipParams(result.place, result.gateway));
    });
    const error = createMemo(() => {
      revision();
      return result.flow.error;
    });
    return (
      <>
        <WhereChip params={params()} state={state()} />
        <div role="alert">{error()}</div>
      </>
    );
  });
  const suggestion = () =>
    expectDefined(
      mounted.container.querySelector<HTMLButtonElement>('[data-value="suggested-cloud"]'),
      "suggested Cloud option",
    );
  const trigger = () =>
    expectDefined(
      mounted.container.querySelector<HTMLButtonElement>("#new-session-where-trigger"),
      "Where trigger",
    );
  await waitForSolid(() => expect(suggestion().disabled).toBe(false));
  return { ...result, ...mounted, suggestion, trigger };
}

it("presents held adoption, retains its error, and selects only the accepted retry result", async () => {
  const result = await renderedFixture();
  const row = result.suggestion();
  row.click();
  await waitForSolid(() => expect(result.suggestion().disabled).toBe(true));
  expect(result.suggestion()).toBe(row);
  expect(result.trigger().disabled).toBe(true);
  expect(result.place.cloudProfileId).toBe("");
  expect(result.request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
  result.adoption.reject(new Error("Cloud login expired"));
  await waitForSolid(() => {
    expect(result.suggestion().disabled).toBe(false);
    expect(result.getByRole("alert").textContent).toBe("Cloud login expired");
  });
  expect(result.suggestion()).toBe(row);
  expect(result.place.cloudProfileId).toBe("");
  const retry = Promise.withResolvers<unknown>();
  result.request.mockImplementation(async (method) => {
    if (method === "environments.adoptSuggestedProfile") {
      return retry.promise;
    }
    if (method === "environments.list") {
      return { environments: [], profiles: [profile] };
    }
    return {};
  });
  result.place.browser.popoverCallbacks("where").onPopoverShow();
  await waitForSolid(() => expect(result.suggestion().disabled).toBe(false));
  result.suggestion().click();
  await waitForSolid(() => expect(result.suggestion().disabled).toBe(true));
  expect(result.place.cloudProfileId).toBe("");
  retry.resolve({ profile });
  await waitForSolid(() => {
    expect(result.place.cloudProfileId).toBe("cloud");
    expect(result.trigger().disabled).toBe(false);
    expect(result.getByRole("alert").textContent).toBe("Cloud login expired");
    expect(result.container.querySelector('[data-value="suggested-cloud"]')).toBeNull();
  });
  result.flow.clearError("Cloud login expired");
  await waitForSolid(() => expect(result.getByRole("alert").textContent).toBe(""));
  expect(result.request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
});

it.each(["local reselection", "Gateway reconnection"] as const)(
  "releases held adoption presentation on %s and ignores its late rejection",
  async (outcome) => {
    const result = await renderedFixture();
    result.suggestion().click();
    await waitForSolid(() => expect(result.trigger().disabled).toBe(true));
    if (outcome === "local reselection") {
      result.place.selectDevice("");
    } else {
      result.context.gateway.snapshot.phase = "connecting";
      result.gateway.synchronize(result.context.gateway);
      result.place.invalidateGatewayDiscovery(true);
    }
    await waitForSolid(() => expect(result.trigger().disabled).toBe(false));
    expect(result.place.cloudProfileId).toBe("");
    result.adoption.reject(new Error("Retired Cloud login expired"));
    await waitForSolid(() => {
      expect(result.getByRole("alert").textContent).toBe("");
      expect(result.trigger().disabled).toBe(false);
    });
    expect(result.place.cloudProfileId).toBe("");
  },
);
