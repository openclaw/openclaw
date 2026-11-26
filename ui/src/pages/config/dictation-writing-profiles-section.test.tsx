/* @vitest-environment jsdom */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { WRITING_PROFILES_PREFERENCE_KEY } from "../../app/dictation-writing-profile-preferences.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConfigRouteContext } from "./config-page.test-support.ts";
import { DictationWritingProfilesSection } from "./dictation-writing-profiles-section.tsx";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

function mountProfiles(entries: Record<string, unknown> = {}, firstRead?: Promise<unknown>) {
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === "users.prefs.get") {
      if (firstRead) {
        const reply = firstRead;
        firstRead = undefined;
        return reply;
      }
      return { status: "ok", entries: structuredClone(entries) };
    }
    if (
      method === "users.prefs.set" &&
      isRecord(params) &&
      isRecord(params.expectedEntries) &&
      isRecord(params.entries)
    ) {
      if (
        Object.entries(params.expectedEntries).some(
          ([key, expected]) => JSON.stringify(entries[key] ?? null) !== JSON.stringify(expected),
        )
      ) {
        return { status: "conflict" };
      }
      Object.assign(entries, structuredClone(params.entries));
      return { status: "ok" };
    }
    throw new Error("Unexpected preference request");
  });
  const client = createTestGatewayClient(request);
  const gateway = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      selfUser: { id: "synthetic-profile" },
    }),
  );
  const context = { ...createConfigRouteContext(), gateway: gateway.gateway };
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <DictationWritingProfilesSection />, { wrapper: provider.wrapper });
  return { ...view, entries, request, gateway };
}

function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

it("starts disabled and preserves an accessible editor draft when another client wins the save", async () => {
  const view = mountProfiles();
  await waitForSolid(() =>
    expect(view.getByLabelText<HTMLInputElement>("Enable writing profiles").checked).toBe(false),
  );
  view.getByRole<HTMLButtonElement>("button", { name: "Create profile" }).click();
  flush();
  const name = view.getByLabelText<HTMLInputElement>("Profile name");
  input(name, "Support chat");
  expect(view.getByLabelText<HTMLInputElement>("Enable this profile").checked).toBe(false);
  view.getByRole<HTMLButtonElement>("button", { name: "Save profiles" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Writing profiles saved"),
  );
  const remote = view.entries[WRITING_PROFILES_PREFERENCE_KEY];
  if (!isRecord(remote)) {
    throw new Error("Expected saved catalog");
  }
  view.entries[WRITING_PROFILES_PREFERENCE_KEY] = { ...remote, revision: "another-client" };
  input(name, "My unsaved support profile");
  view.getByRole<HTMLButtonElement>("button", { name: "Save profiles" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Another client changed"),
  );
  expect(view.getByLabelText<HTMLInputElement>("Profile name").value).toBe(
    "My unsaved support profile",
  );
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: "Export unsaved draft" }).disabled,
  ).toBe(false);
  expect(view.container.textContent).toContain(
    "External application and browser-origin matching are unavailable",
  );
  expect(view.container.textContent).toContain("Register suggestions are advisory");
});

it("preserves a draft during unresolved reconnects and requires a fresh saved receipt before writing", async () => {
  const view = mountProfiles();
  await waitForSolid(() => expect(view.getByLabelText("Enable writing profiles")).toBeTruthy());
  view.getByRole<HTMLButtonElement>("button", { name: "Create profile" }).click();
  flush();
  input(view.getByLabelText<HTMLInputElement>("Profile name"), "Keep across a network drop");
  view.gateway.publish({
    ...view.gateway.gateway.snapshot,
    phase: "reconnecting",
    selfUser: undefined,
  });
  flush();
  expect(view.getByLabelText<HTMLInputElement>("Profile name").value).toBe(
    "Keep across a network drop",
  );
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: "Export unsaved draft" }).disabled,
  ).toBe(false);
  view.gateway.publish({
    ...view.gateway.gateway.snapshot,
    phase: "connected",
    selfUser: { id: "synthetic-profile" },
  });
  flush();
  expect(view.getByLabelText<HTMLInputElement>("Profile name").value).toBe(
    "Keep across a network drop",
  );
  expect(view.getByRole<HTMLButtonElement>("button", { name: "Save profiles" }).disabled).toBe(
    true,
  );
  expect(view.getByRole("status").textContent).toContain("export your draft, then refresh");
  expect(view.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toHaveLength(
    0,
  );
  view.getByRole<HTMLButtonElement>("button", { name: "Refresh saved version" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Saved settings loaded"),
  );
  view.getByRole<HTMLButtonElement>("button", { name: "Create profile" }).click();
  flush();
  input(view.getByLabelText<HTMLInputElement>("Profile name"), "Reconciled draft");
  view.getByRole<HTMLButtonElement>("button", { name: "Save profiles" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Writing profiles saved"),
  );
});

it("imports through the visible control with activation disabled and quarantines a future schema", async () => {
  const view = mountProfiles();
  await waitForSolid(() => expect(view.getByLabelText("Enable writing profiles")).toBeTruthy());
  view.getByText("Import and export").click();
  flush();
  const textarea = view.getByLabelText<HTMLTextAreaElement>("Writing profiles JSON");
  input(
    textarea,
    JSON.stringify({
      schemaVersion: 1,
      revision: "imported",
      enabled: true,
      defaultProfileId: "email",
      profiles: [
        {
          id: "email",
          revision: "profile-1",
          label: "Email",
          enabled: true,
          priority: 1,
          selectors: [],
          policy: {
            handling: "prose",
            locale: null,
            punctuation: "automatic",
            capitalization: "sentence",
            fillers: "preserve",
            corrections: "preserve",
            structure: "paragraphs",
            register: "email",
          },
        },
      ],
    }),
  );
  view
    .getByRole<HTMLButtonElement>("button", { name: "Import with all profiles disabled" })
    .click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain(
      "Profiles imported with all activation disabled",
    ),
  );
  expect(view.getByLabelText<HTMLInputElement>("Enable writing profiles").checked).toBe(false);
  expect(view.getByLabelText<HTMLInputElement>("Enable this profile").checked).toBe(false);
  const saved = JSON.stringify(view.entries);
  input(textarea, '{"schemaVersion":99,"futureData":{"keep":true}}');
  view
    .getByRole<HTMLButtonElement>("button", { name: "Import with all profiles disabled" })
    .click();
  await waitForSolid(() =>
    expect(view.queryByRole("button", { name: "Export quarantined import" })).not.toBeNull(),
  );
  expect(JSON.stringify(view.entries)).toBe(saved);
  expect(view.getByLabelText<HTMLInputElement>("Profile name").value).toBe("Email");
  view.gateway.publish({
    ...view.gateway.gateway.snapshot,
    phase: "reconnecting",
    selfUser: undefined,
  });
  flush();
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: "Export quarantined import" }).disabled,
  ).toBe(false);
});

it("keeps an unsupported saved catalog read-only and ignores an old account's late load", async () => {
  const pending = createDeferred<unknown>();
  const view = mountProfiles(
    { [WRITING_PROFILES_PREFERENCE_KEY]: { schemaVersion: 99, futureData: "preserve" } },
    pending.promise,
  );
  flush();
  view.gateway.publish({ ...view.gateway.gateway.snapshot, selfUser: { id: "new-profile" } });
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("read-only and inactive"),
  );
  view.getByText("Import and export").click();
  flush();
  expect(view.queryByLabelText("Enable writing profiles")).toBeNull();
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: "Export saved profiles" }).disabled,
  ).toBe(false);
  expect(
    view.getByRole<HTMLButtonElement>("button", { name: "Import with all profiles disabled" })
      .disabled,
  ).toBe(true);
  pending.resolve({ status: "ok", entries: {} });
  await pending.promise;
  flush();
  expect(view.getByRole("status").textContent).toContain("read-only and inactive");
});
