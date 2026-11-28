/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UsersPrefsSetParams } from "../../../../../packages/gateway-protocol/src/schema/users.ts";
import {
  createVoiceSnippetCatalog,
  exportVoiceSnippetCatalog,
  validateVoiceSnippetCatalog,
  VOICE_SNIPPETS_PREFERENCE_KEY,
  type VoiceSnippetCatalog,
} from "../../../../../src/shared/voice-snippets.ts";
import * as downloads from "../../../lib/download.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import {
  createModalDialogTestFixture,
  getRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { VoiceSnippetCatalogView } from "../voice-snippet-catalog.ts";
import { showVoiceSnippetCatalog } from "./voice-snippets.tsx";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
const key = VOICE_SNIPPETS_PREFERENCE_KEY;
const sample: VoiceSnippetCatalog = {
  ...createVoiceSnippetCatalog(),
  revision: 1,
  snippets: [
    {
      schemaVersion: 1,
      id: "signature",
      revision: 1,
      name: "Signature",
      locale: "en-US",
      triggers: ["signature"],
      body: "Thanks,\nAlex",
      enabled: true,
      sensitivity: "normal",
    },
  ],
};

beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});
afterEach(async () => {
  await dialogs.cleanup();
  vi.restoreAllMocks();
});

function gateway(initial?: VoiceSnippetCatalog) {
  let saved = initial;
  let rejectWrite = false;
  let denied = false;
  let offline = false;
  const request = vi.fn(async (method: string, params: unknown) => {
    if (denied) {
      return { status: "no_durable_identity" };
    }
    if (offline) {
      throw new Error("Unavailable");
    }
    if (method === "users.prefs.get") {
      return { status: "ok", entries: saved ? { [key]: saved } : {} };
    }
    if (method !== "users.prefs.set") {
      throw new Error("Unexpected RPC");
    }
    // SAFETY: this fixture handles only the existing preference RPC's typed caller.
    const write = params as UsersPrefsSetParams;
    if (
      rejectWrite ||
      JSON.stringify(write.expectedEntries?.[key]) !== JSON.stringify(saved ?? null)
    ) {
      return { status: "conflict" };
    }
    saved = validateVoiceSnippetCatalog(write.entries[key]);
    return { status: "ok" };
  });
  const client = createTestGatewayClient(request);
  Object.defineProperty(client, "connected", { configurable: true, get: () => true });
  return {
    client,
    request,
    saved: () => saved,
    conflict: () => {
      rejectWrite = true;
    },
    deny: () => {
      denied = true;
    },
    offline: () => {
      offline = true;
    },
  };
}

async function open(client: ReturnType<typeof gateway>["client"]) {
  const lifetime = new AbortController();
  const closed = dialogs.track(showVoiceSnippetCatalog({ client, signal: lifetime.signal }));
  await getRenderedModalDialog(document.body);
  const query = getQueriesForElement(document.body);
  await waitForSolid(() =>
    expect(query.getByRole("button", { name: "New snippet" })).toBeDefined(),
  );
  return { query, lifetime, closed };
}

function fill(label: string, text: string) {
  const element = getQueriesForElement(document.body).getByLabelText(label);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error("Expected an editable field");
  }
  element.value = text;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  return element;
}

function submit() {
  document.body
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function readyButton(name: string) {
  return waitForSolid(() => {
    const button = getQueriesForElement(document.body).getByRole("button", { name });
    expect(button).toHaveProperty("disabled", false);
    return button;
  });
}

it("authors and edits exact static text, searches it, toggles availability, and confirms deletion", async () => {
  const harness = gateway();
  const { query, closed } = await open(harness.client);
  query.getByRole("button", { name: "New snippet" }).click();
  flush();
  fill("Name", "Support signature");
  fill("Triggers, one per line", "support signature");
  const body = "00017\n{{name}} <date> $HOME\n\ninsert snippet other";
  fill("Exact text", body);
  submit();
  await waitForSolid(() => expect(query.getByText("Snippet saved.")).toBeDefined());
  expect(harness.saved()?.snippets[0]?.body).toBe(body);
  expect(harness.saved()?.enabled).toBe(false);
  const savedId = harness.saved()?.snippets[0]?.id;
  query.getByRole("button", { name: "Edit snippet" }).click();
  flush();
  fill("Exact text", `${body}\nUpdated`);
  submit();
  await readyButton("Edit snippet");
  expect(harness.saved()?.snippets[0]?.body).toBe(`${body}\nUpdated`);
  expect(harness.saved()?.snippets[0]?.id).toBe(savedId);
  query.getByRole("checkbox", { name: "Enable voice snippets" }).click();
  await readyButton("Disable");
  expect(harness.saved()?.enabled).toBe(true);
  fill("Search snippet names and triggers", "support");
  expect(query.getByText("Support signature")).toBeDefined();
  query.getByRole("button", { name: "Disable" }).click();
  await readyButton("Delete snippet");
  expect(harness.saved()?.snippets[0]?.enabled).toBe(false);
  query.getByRole("button", { name: "Delete snippet" }).click();
  flush();
  expect(harness.saved()?.snippets).toHaveLength(1);
  query.getByRole("button", { name: "Cancel" }).click();
  flush();
  query.getByRole("button", { name: "Delete snippet" }).click();
  flush();
  query.getByRole("button", { name: "Delete snippet" }).click();
  await readyButton("New snippet");
  expect(harness.saved()?.snippets).toHaveLength(0);
  query.getAllByRole("button", { name: "Close" }).at(-1)?.click();
  await closed;
});

it("previews an import before replacing the catalog and exports the confirmed exact text", async () => {
  const harness = gateway(sample);
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const { query } = await open(harness.client);
  const imported: VoiceSnippetCatalog = {
    ...sample,
    snippets: [
      {
        ...sample.snippets[0]!,
        id: "imported",
        name: "Imported",
        body: "00017\r\n{{value}}\u0000",
      },
    ],
  };
  const data = exportVoiceSnippetCatalog(imported);
  const file = new File([data], "snippets.json", { type: "application/json" });
  // jsdom's File lacks Blob.text; this is the selected-file I/O boundary.
  Object.defineProperty(file, "text", { value: async () => data });
  const input = query.getByLabelText("Choose a version 1 snippet file");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected native file input");
  }
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() =>
    expect(query.getByRole("button", { name: "Replace catalog" })).toBeDefined(),
  );
  expect(harness.saved()?.snippets[0]?.id).toBe("signature");
  expect(query.getByLabelText("Imported: Plain-text preview")).toHaveProperty("readOnly", true);
  query.getByRole("button", { name: "Replace catalog" }).click();
  const exportButton = await readyButton("Export JSON");
  expect(harness.saved()?.snippets[0]?.body).toBe(imported.snippets[0]?.body);
  exportButton.click();
  await waitForSolid(() =>
    expect(download).toHaveBeenCalledExactlyOnceWith(
      "openclaw-voice-snippets.json",
      data,
      "application/json",
    ),
  );
});

it("keeps an edit visible after collision and concurrent-write conflicts", async () => {
  const harness = gateway(sample);
  const { query } = await open(harness.client);
  query.getByRole("button", { name: "New snippet" }).click();
  flush();
  fill("Name", "Second signature");
  fill("Triggers, one per line", "SIGNATURE");
  const body = fill("Exact text", "Do not lose this draft");
  submit();
  await waitForSolid(() =>
    expect(query.getByRole("alert").textContent).toContain("already uses this trigger"),
  );
  expect(body.value).toBe("Do not lose this draft");
  expect(harness.saved()?.snippets).toHaveLength(1);
  fill("Triggers, one per line", "other signature");
  harness.conflict();
  submit();
  await waitForSolid(() =>
    expect(query.getByRole("alert").textContent).toContain("Saved snippets changed"),
  );
  expect(body.value).toBe("Do not lose this draft");
  expect(harness.saved()?.snippets[0]?.name).toBe("Signature");
});

it("invalidates a pending catalog read when the dialog's account lifetime ends", async () => {
  const reply = Promise.withResolvers<unknown>();
  const client = createTestGatewayClient(() => reply.promise);
  Object.defineProperty(client, "connected", { configurable: true, get: () => true });
  const lifetime = new AbortController();
  const view = new VoiceSnippetCatalogView(client, lifetime.signal);
  const pending = view.load();
  lifetime.abort();
  reply.resolve({ status: "ok", entries: { [key]: sample } });
  await expect(pending).resolves.toBe(false);
  expect(view.catalog).toBeNull();
  await expect(view.edit({ type: "enabled", enabled: true })).resolves.toBe(false);
});

it("keeps an unfinished edit after a failed save without retrying the write", async () => {
  const harness = gateway(sample);
  const { query } = await open(harness.client);
  query.getByRole("button", { name: "Edit snippet" }).click();
  flush();
  fill("Exact text", "Unfinished edit");
  harness.offline();
  submit();
  await waitForSolid(() => expect(query.getByRole("alert").textContent).toContain("unavailable"));
  expect(query.getByLabelText("Exact text")).toHaveProperty("value", "Unfinished edit");
  expect(query.getByRole("button", { name: "Reload saved catalog" })).toBeDefined();
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.prefs.set"),
  ).toHaveLength(1);
  expect(harness.saved()).toBe(sample);
});

it("removes an open editor when current personal authorization is denied", async () => {
  const harness = gateway(sample);
  const { query } = await open(harness.client);
  query.getByRole("button", { name: "Edit snippet" }).click();
  flush();
  fill("Exact text", "Private unfinished edit");
  harness.deny();
  submit();
  await waitForSolid(() =>
    expect(query.getByRole("alert").textContent).toContain("durable personal identity"),
  );
  expect(query.queryByLabelText("Exact text")).toBeNull();
  expect(query.queryByRole("button", { name: "New snippet" })).toBeNull();
  expect(query.queryByRole("button", { name: "Reload saved catalog" })).toBeNull();
  expect(harness.saved()?.snippets[0]?.body).toBe("Thanks,\nAlex");
});

it("clears its authorized cache when an export read fails and requires a new view", async () => {
  const harness = gateway(sample);
  const view = new VoiceSnippetCatalogView(harness.client, new AbortController().signal);
  expect(await view.load()).toBe(true);
  harness.offline();
  await expect(view.export()).resolves.toBeNull();
  expect(view.catalog).toBeNull();
  expect(view.error).toBe("unavailable");
  const requests = harness.request.mock.calls.length;
  await expect(view.load()).resolves.toBe(false);
  expect(harness.request).toHaveBeenCalledTimes(requests);
});

it("never retries a failed import or writes part of an invalid file", async () => {
  const harness = gateway(sample);
  const view = new VoiceSnippetCatalogView(harness.client, new AbortController().signal);
  await view.load();
  await expect(
    view.edit({ type: "import", data: '{"schemaVersion":2,"snippets":[]}' }),
  ).resolves.toBe(false);
  expect(harness.saved()?.snippets[0]?.body).toBe("Thanks,\nAlex");
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.prefs.set"),
  ).toHaveLength(0);
  harness.conflict();
  await expect(view.edit({ type: "enabled", enabled: true })).resolves.toBe(false);
  expect(
    harness.request.mock.calls.filter(([method]) => method === "users.prefs.set"),
  ).toHaveLength(1);
  expect(view.error).toBe("conflict");
});
