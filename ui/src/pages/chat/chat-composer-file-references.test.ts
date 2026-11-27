/* @vitest-environment jsdom */
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createSessionGoalFixture } from "../../../../src/gateway/session-goal.test-support.js";
import { prepareFileReferenceDestination } from "../../lib/chat/file-reference-destination.ts";
import { composerFileReferenceFixture } from "../../lib/chat/file-references.test-support.ts";
import { fileReferenceText } from "../../lib/chat/file-references.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerProps,
  disposeComposer,
  findComposerButton,
  renderComposerFixture,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { acquireMissingGeometry } from "./composer-file-reference-destination.test-support.ts";
import { readComposerFileReferenceSource } from "./composer-file-references.ts";

afterEach(() => resetComposerFixture());

it("creates the review owner only on opt-in and revokes consent on composer remount", async () => {
  const originalClient = createTestGatewayClient(async () => ({}));
  const replacementClient = createTestGatewayClient(async () => ({}));
  const { container, props } = renderComposerFixture({ gatewayClient: originalClient });
  document.body.appendChild(container);
  const pane = getChatComposerState(props.paneId);
  expect(pane.fileReferences).toBeNull();
  const optIn = container.querySelector<HTMLInputElement>(".composer-file-references input")!;
  expect(optIn.checked).toBe(false);
  optIn.click();
  await waitForSolid(() => expect(pane.fileReferences?.enabled).toBe(true));
  const owner = pane.fileReferences!;
  disposeComposer(container);
  const replacement = createComposerProps({
    ...props,
    connected: false,
    sessionKey: "replacement",
    gatewayClient: replacementClient,
  });
  renderComposerInto(container, replacement);
  expect(getChatComposerState(props.paneId).fileReferences).toBe(owner);
  expect(owner.enabled).toBe(false);
  owner.enable(true);
  expect(owner.enabled).toBe(false);
  replacement.connected = true;
  renderComposerInto(container, replacement);
  owner.enable(true);
  expect(owner.enabled).toBe(true);
});

it("binds a captured source's outgoing requests to its exact gateway client", async () => {
  const oldRequest = vi.fn(async () => ({ status: "released" }));
  const newRequest = vi.fn(async () => ({ status: "released" }));
  const original = createTestGatewayClient(oldRequest);
  const props = createComposerProps({ gatewayClient: original, sessionKey: "old-session" });
  const source = readComposerFileReferenceSource(props, {
    editRevision: 7,
    composerTextarea: null,
  });
  props.gatewayClient = createTestGatewayClient(newRequest);
  props.sessionKey = "new-session";
  const release = {
    schemaVersion: 1,
    action: "release",
    sessionKey: source.sessionKey,
    leaseId: "old-lease",
    context: {
      captureId: "capture",
      generation: 1,
      transcriptRevision: 1,
      targetId: "target",
      draftRevision: 7,
    },
  } as const;
  await source.request(release);
  expect(source.client).toBe(original);
  expect(oldRequest).toHaveBeenCalledExactlyOnceWith("sessions.files.references", release);
  expect(newRequest).not.toHaveBeenCalled();
});

it("requires explicit conversion before goal editing can borrow and restore the draft", async () => {
  onTestFinished(acquireMissingGeometry());
  const reference = composerFileReferenceFixture;
  const draft = fileReferenceText(reference.reference);
  const goal = createSessionGoalFixture("goal-with-reference", "Revise this objective");
  const { container, props } = renderComposerFixture({
    draft: "reference file src/example.ts end reference",
    fileReferences: [],
    currentSessionId: "goal-session",
    selectedSession: {
      key: "main",
      sessionId: "goal-session",
      kind: "direct",
      updatedAt: 1,
      goal,
    },
    onGoalAction: vi.fn(),
    onGoalDraftModeChange: vi.fn(),
    onGoalSubmit: vi.fn(async () => true),
  });
  document.body.appendChild(container);
  await waitForSolid(() => expect(findComposerButton(container, "Edit goal")).toBeTruthy());
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const destination = (await prepareFileReferenceDestination(input))!;
  const snapshot = destination.snapshot();
  expect(
    destination.commit({
      id: "reference-before-goal-edit",
      snapshot,
      from: 0,
      to: snapshot.text.length,
      text: draft,
      references: [reference],
    }),
  ).toEqual({ status: "committed" });
  // Goal admission reads the current draft owner before the projected props flush.
  findComposerButton(container, "Edit goal").click();
  flush();
  expect(props.onGoalDraftModeChange).not.toHaveBeenCalled();
  expect(props).toMatchObject({ draft, fileReferences: [reference] });
  expect(container.querySelector(".agent-chat__goal-mode")).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Convert file references to plain text before sending",
  );

  // A bound draft exposes Convert without a recognition owner or Gateway client.
  expect(getChatComposerState(props.paneId).fileReferences).toBeNull();
  const convert = () =>
    container.querySelector<HTMLButtonElement>(".composer-file-references button");
  await waitForSolid(() =>
    expect(convert()?.textContent).toContain("Convert file references to plain text"),
  );
  convert()!.click();
  await waitForSolid(() => expect(props.fileReferences).toEqual([]));
  expect(props.draft).toBe(draft);
  const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-content")!)!;
  for (const [change, fileReferences] of [
    [undo, [reference]],
    [redo, []],
  ] as const) {
    expect(change(editor)).toBe(true);
    flush();
    expect(props).toMatchObject({ draft, fileReferences });
  }
  findComposerButton(container, "Edit goal").click();
  await waitForSolid(() => expect(findComposerButton(container, "Cancel goal entry")).toBeTruthy());
  expect(props.draft).toBe(goal.objective);
  findComposerButton(container, "Cancel goal entry").click();
  await waitForSolid(() => expect(container.querySelector(".agent-chat__goal-mode")).toBeNull());
  expect(props).toMatchObject({ draft, fileReferences: [] });
  expect(props.onGoalSubmit).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
});
