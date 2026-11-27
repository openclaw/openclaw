/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceSnippetCatalog } from "../../../../../src/shared/voice-snippets.ts";
import * as downloads from "../../../lib/download.ts";
import {
  createModalDialogTestFixture,
  getRenderedModalDialog,
} from "../../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { VoiceSnippetReview } from "../voice-snippet-review.ts";
import { showVoiceSnippetReview } from "./voice-snippet-review.tsx";

let dialogs: ReturnType<typeof createModalDialogTestFixture>;
beforeEach(() => {
  dialogs = createModalDialogTestFixture();
});
afterEach(async () => {
  await dialogs.cleanup();
  vi.restoreAllMocks();
});

function catalog(body: string): VoiceSnippetCatalog {
  return {
    schemaVersion: 1,
    revision: 1,
    enabled: true,
    snippets: [
      {
        schemaVersion: 1,
        id: "signature",
        revision: 1,
        name: "Signature",
        locale: "en-US",
        triggers: ["signature"],
        body,
        enabled: true,
        sensitivity: "sensitive",
      },
    ],
  };
}

async function open(saved: VoiceSnippetCatalog, rawTranscript = "insert snippet signature") {
  const invoker = document.createElement("button");
  document.body.append(invoker);
  invoker.focus();
  const lifetime = new AbortController();
  const deliver = vi.fn(() => "committed" as const);
  let connected = true;
  const owner = new VoiceSnippetReview({
    request: {
      schemaVersion: 1,
      captureId: "review",
      generation: 1,
      transcriptRevision: 1,
      mode: "dictation",
      rawTranscript,
    },
    catalog: saved,
    signal: lifetime.signal,
    isCurrent: () => connected,
    deliver,
  });
  await owner.prepare();
  const closed = dialogs.track(showVoiceSnippetReview({ owner, signal: lifetime.signal }));
  const { modal } = await getRenderedModalDialog(document.body);
  const query = getQueriesForElement(document.body);
  const preview = query.getByLabelText("Complete dictation preview");
  if (!(preview instanceof HTMLTextAreaElement)) {
    throw new Error("Expected plain-text preview");
  }
  return {
    owner,
    lifetime,
    deliver,
    disconnect: () => {
      connected = false;
    },
    closed,
    modal,
    query,
    preview,
    invoker,
  };
}

it("shows complete literal sensitive text in a focused readonly preview before one explicit acceptance", async () => {
  const body = `00017\n{{name}} <script>alert(1)</script> $HOME\n\n${"long text ".repeat(200)}`;
  const { query, preview, deliver, closed, invoker } = await open(catalog(body));
  expect(preview.value).toBe(body);
  expect(preview.readOnly).toBe(true);
  expect(document.body.querySelector("script")).toBeNull();
  await waitForSolid(() => expect(document.activeElement).toBe(preview));
  expect(deliver).not.toHaveBeenCalled();
  query.getByRole("button", { name: "Add to draft" }).click();
  await expect(closed).resolves.toBe(true);
  expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: body }));
  await waitForSolid(() => expect(document.activeElement).toBe(invoker));
});

it("blocks recovery and Apply after the capture loses its connection", async () => {
  const { owner, deliver, disconnect } = await open(catalog("Private exact text"));
  disconnect();
  expect(owner.exportText()).toBeNull();
  await expect(owner.accept()).resolves.toBe(false);
  expect(deliver).not.toHaveBeenCalled();
});

it("does not duplicate acceptance when Apply is clicked twice", async () => {
  const { query, owner, deliver, closed } = await open(catalog("Exact body"));
  const accept = query.getByRole("button", { name: "Add to draft" });
  accept.click();
  accept.click();
  await expect(closed).resolves.toBe(true);
  await expect(owner.accept()).resolves.toBe(false);
  expect(deliver).toHaveBeenCalledOnce();
});

it("clears the admitted result and blocks recovery on explicit cancellation", async () => {
  const { query, owner, deliver, closed } = await open(catalog("Exact body"));
  query.getByRole("button", { name: "Cancel" }).click();
  await expect(closed).resolves.toBe(false);
  expect(owner.snapshot()).toMatchObject({ text: "", sourceText: "", canAccept: false });
  expect(owner.exportText()).toBeNull();
  expect(deliver).not.toHaveBeenCalled();
});

it("expands two deliberate source selections without changing surrounding prose and modal cancel prevents delivery", async () => {
  const phrase = "insert snippet signature";
  const source = `Before. ${phrase}. Middle. ${phrase}. After.`;
  const { query, preview, deliver, closed, modal } = await open(catalog("00017\n{{name}}"), source);
  expect(preview.value).toBe(source);
  const original = query.getByLabelText(
    "Original transcript; select a standalone command segment to expand",
  );
  if (!(original instanceof HTMLTextAreaElement)) {
    throw new Error("Expected original transcript");
  }
  for (const start of [source.indexOf(phrase), source.lastIndexOf(phrase)]) {
    original.setSelectionRange(start, start + phrase.length);
    query.getByRole("button", { name: "Expand selected phrase" }).click();
    await waitForSolid(() =>
      expect(query.getByRole("button", { name: "Add to draft" })).not.toHaveProperty(
        "disabled",
        true,
      ),
    );
  }
  expect(preview.value).toBe("Before. 00017\n{{name}}. Middle. 00017\n{{name}}. After.");
  modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  await expect(closed).resolves.toBe(false);
  expect(deliver).not.toHaveBeenCalled();
});

it("requires an explicit radio choice for an ambiguous trigger and previews that definition", async () => {
  const saved = catalog("American text");
  saved.snippets.push({
    ...saved.snippets[0]!,
    id: "uk",
    locale: "en-GB",
    name: "UK signature",
    body: "British text",
  });
  const { query, preview, deliver, closed } = await open(saved);
  expect(query.getByRole("group", { name: "Choose a snippet" })).toBeDefined();
  expect(query.getByRole("button", { name: "Add to draft" })).toHaveProperty("disabled", true);
  query.getByRole("radio", { name: "UK signature" }).click();
  await waitForSolid(() => expect(preview.value).toBe("British text"));
  expect(document.activeElement).toBe(preview);
  expect(deliver).not.toHaveBeenCalled();
  query.getByRole("button", { name: "Add to draft" }).click();
  await expect(closed).resolves.toBe(true);
  expect(deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: "British text" }),
  );
});

it("downloads exact CRLF and NUL text without attempting insertion and retires when the account lifetime ends", async () => {
  const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
  const body = "line 1\r\nline 2\u0000";
  const { query, deliver, lifetime, closed } = await open(catalog(body));
  expect(query.getByRole("button", { name: "Add to draft" })).toHaveProperty("disabled", true);
  query.getByRole("button", { name: "Download plain text" }).click();
  await waitForSolid(() =>
    expect(download).toHaveBeenCalledExactlyOnceWith("openclaw-dictation.txt", body),
  );
  lifetime.abort();
  flush();
  await expect(closed).resolves.toBe(false);
  expect(deliver).not.toHaveBeenCalled();
  expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
});
