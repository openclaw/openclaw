// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from "vitest";
import { patchSettings } from "../../app/settings.ts";
import { installNativeTextEditing } from "../../test-helpers/native-text-editing.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createComposerContainer,
  createComposerProps,
  disposeComposer,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import { setupComposerDictationTestHarness } from "./composer-dictation.test-support.ts";

const {
  createClient,
  emit,
  pointerTarget,
  releaseLatched,
  request,
  sessionResult,
  startHold,
  transcript,
} = setupComposerDictationTestHarness();

it.each([
  {
    name: "syntax with boundary whitespace",
    early: [" \tsnake case customer ID end identifier\n "],
    late: [],
    raw: " \tsnake case customer ID end identifier\n ",
    expected: " \tcustomer_id\n ",
  },
  {
    name: "supplied chunk boundaries",
    early: [" \tfirst\n"],
    late: ["\tsecond \n"],
    raw: " \tfirst\n\tsecond \n",
    expected: " \tfirst\n\tsecond \n",
  },
  {
    name: "whitespace-only live final",
    early: [" \t\n "],
    late: [],
    raw: " \t\n ",
    expected: " \t\n ",
  },
  {
    name: "whitespace-only late final",
    early: [],
    late: [" \t\n "],
    raw: " \t\n ",
    expected: " \t\n ",
  },
  {
    name: "CR and CRLF copy-only output",
    early: ["\tA\r\n"],
    late: ["B\rC "],
    raw: "\tA\r\nB\rC ",
    expected: "\tA\r\nB\rC ",
  },
  {
    name: "explicit separator between non-whitespace boundaries",
    early: ["first"],
    late: ["second"],
    raw: "first second",
    expected: "first second",
  },
  {
    name: "disabled baseline revision notifications",
    early: ["first"],
    late: [],
    raw: "first",
    expected: "first",
    review: false,
  },
  {
    name: "review enabled elsewhere after a retained pane remount",
    early: ["snake case customer ID end identifier"],
    late: [],
    raw: "snake case customer ID end identifier",
    expected: "customer_id",
    reenabledAfterRemount: true,
  },
])("delivers mounted microphone capture through Stop and review: $name", async (scenario) => {
  onTestFinished(installNativeTextEditing(document));
  const { early, late, raw, expected } = scenario;
  const reviewing = !("review" in scenario && scenario.review === false);
  const reenabledAfterRemount =
    "reenabledAfterRemount" in scenario && scenario.reenabledAfterRemount;
  request.mockImplementation(async (method) => {
    if (method === "talk.catalog") {
      return {
        transcription: { ready: true, providers: [] },
        realtime: { ready: false, providers: [] },
      };
    }
    if (method === "talk.config") {
      return { config: {} };
    }
    return method === "talk.session.create" ? sessionResult() : { ok: true };
  });
  patchSettings({
    developerDictation: {
      schemaVersion: 1,
      enabled: reviewing && !reenabledAfterRemount,
      mode: "developer",
      locale: "en-US",
      profileId: "en-us-plain-code",
      profiles: [],
    },
  });
  let draft = "Existing ";
  const props = createComposerProps({
    draft,
    getDraft: () => draft,
    gatewayClient: createClient(),
    onToggleRealtimeTalk: vi.fn(),
    onDraftChange: vi.fn((next) => {
      draft = next;
    }),
  });
  const container = document.body.appendChild(createComposerContainer());
  renderComposerInto(container, props);
  const state = getChatComposerState(props.paneId);
  if (reenabledAfterRemount) {
    container.querySelector<HTMLElement>(".developer-syntax summary")!.click();
    await waitForFast(() => {
      flush();
      expect(state.developerSyntax).not.toBeNull();
    });
    disposeComposer(container);
    renderComposerInto(container, props);
    expect(container.querySelector(".developer-syntax fieldset")).toBeNull();
    expect(container.querySelector(".developer-syntax__review")).toBeNull();
    patchSettings({
      developerDictation: { ...state.developerSyntax!.settings, enabled: true },
    });
  }
  const input = state.composerTextarea!;
  input.setSelectionRange(draft.length, draft.length);
  const controller = state.dictation!;
  try {
    await waitForFast(() => expect(state.microphonePicker?.dictationStatus).toBe("ready"));
    if (reviewing) {
      await waitForFast(() => expect(state.developerSyntax).not.toBeNull());
    }
    flush();
    const microphoneButton = pointerTarget(
      container.querySelector<HTMLButtonElement>(".chat-talk-control button")!,
    );
    await startHold(microphoneButton);
    await waitForFast(() => expect(controller.connecting).toBe(false));
    await releaseLatched(microphoneButton);
    const revisionBeforePartial = state.editRevision;
    emit({ type: "partial", text: "snake case customer ID end identifier" });
    flush();
    if (reviewing) {
      expect(input.value).toBe("Existing ");
      expect(state.editRevision).toBe(revisionBeforePartial);
    } else {
      expect(state.editRevision).toBeGreaterThan(revisionBeforePartial);
    }
    if (reviewing) {
      expect(state.developerSyntax?.blocksSend).toBe(true);
    } else {
      expect(state.developerSyntax).toBeNull();
    }
    for (const chunk of early) {
      transcript(chunk);
    }
    const finish = vi.spyOn(controller, "finishActive");
    microphoneButton.click();
    const finished = finish.mock.results[0]?.value;
    expect(finished).toBeDefined();
    for (const chunk of late) {
      transcript(chunk);
    }
    emit({ type: "close", reason: "completed" });
    expect(await finished).toBe(!reviewing);
    flush();
    if (!reviewing) {
      expect(state.developerSyntax).toBeNull();
      expect(draft).toBe(`Existing ${expected}`);
      expect(props.onDraftChange).toHaveBeenCalledOnce();
      expect(props.onSend).not.toHaveBeenCalled();
      return;
    }
    expect(state.developerSyntax?.review?.raw).toBe(raw);
    expect(state.developerSyntax?.review?.text).toBe(expected);
    expect(draft).toBe("Existing ");
    await waitForFast(() => {
      flush();
      expect(container.querySelector(".developer-syntax__review")).not.toBeNull();
    });
    const insert = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Insert into draft",
    )!;
    expect(insert).toBeDefined();
    if (expected.includes("\r")) {
      expect(insert.disabled).toBe(true);
      expect(state.developerSyntax?.accept()).toBe(false);
      expect(state.developerSyntax?.review?.text).toBe(expected);
      expect(props.onDraftChange).not.toHaveBeenCalled();
    } else {
      insert.click();
      flush();
      expect(draft).toBe(`Existing ${expected}`);
      expect(props.onDraftChange).toHaveBeenCalledOnce();
    }
    expect(props.onSend).not.toHaveBeenCalled();
  } finally {
    await resetComposerFixture();
  }
});
