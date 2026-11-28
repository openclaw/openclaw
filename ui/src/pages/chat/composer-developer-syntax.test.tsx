import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { builtinDeveloperProfiles } from "../../../../src/shared/dictation-developer.ts";
import type { DeveloperDictationSettings } from "../../app/settings-developer-dictation.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { readComposerEditor, selectComposerInput } from "../../lib/composer-input.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { installNativeTextEditing } from "../../test-helpers/native-text-editing.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { mountMentionComposerEditor } from "./components/composer-editor-mentions.tsx";
import { ComposerDeveloperSyntax } from "./composer-developer-syntax.ts";
import { captureDeveloperDictationTarget } from "./composer-developer-target.ts";

const enabled: DeveloperDictationSettings = {
  schemaVersion: 1,
  enabled: true,
  mode: "developer",
  locale: "en-US",
  profileId: "en-us-plain-code",
  profiles: [],
};
const exact = "start code space tab new line space end code";
const original = "snake case customer account ID end identifier";

beforeEach(() => {
  onTestFinished(installNativeTextEditing(document));
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  patchSettings({ developerDictation: enabled });
});
afterEach(() => resetComposerFixture());

async function fixture(
  initial = "",
  initialMentions: readonly HumanMention[] = [],
  overrides: Partial<ChatComposerProps> = {},
) {
  let draft = initial;
  let mentions = initialMentions;
  const source = createComposerDraftSource(() => ({
    draft,
    mentions,
    attachments: [],
    pendingAttachmentReads: 0,
    goalDraftMode: overrides.goalDraftMode,
  }));
  const props = createComposerProps({
    draft: initial,
    getDraft: () => draft,
    getMentions: () => mentions,
    draftSource: source,
    gatewayClient: createTestGatewayClient(async () => ({})),
    onToggleRealtimeTalk: vi.fn(),
    onHistoryKeydown: vi.fn(),
    onDraftChange: vi.fn((next: string, nextMentions?: readonly HumanMention[]) => {
      draft = next;
      mentions = nextMentions ?? [];
      source.publish();
    }),
    ...overrides,
  });
  const container = createComposerContainer();
  document.body.append(container);
  renderComposerInto(container, props);
  const state = getChatComposerState(props.paneId);
  const input = state.composerTextarea!;
  container.querySelector<HTMLElement>(".developer-syntax summary")!.click();
  await waitForSolid(() => {
    expect(state.developerSyntax).not.toBeNull();
    expect(container.querySelector(".developer-syntax fieldset")).not.toBeNull();
  });
  const owner = state.developerSyntax!;
  const button = (name: string) => {
    const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    expect(match, name).toBeDefined();
    return match!;
  };
  const capture = (raw = original) => {
    const captured = owner.capture();
    expect(captured).toBeDefined();
    captured!.finish(raw);
    flush();
    return captured!;
  };
  return {
    props,
    container,
    state,
    input,
    owner,
    source,
    button,
    capture,
    draft: () => draft,
    mentions: () => mentions,
  };
}

it.each([
  { kind: "native", initial: "hello", mentions: [] },
  {
    kind: "recipient",
    initial: "@Alex hello",
    mentions: [{ profileId: "alex", start: 0, end: 5 }],
  },
])(
  "reviews exact bytes and preserves recipients in the $kind composer",
  async ({ kind, initial, mentions }) => {
    const view = await fixture(initial, mentions);
    // A selected recipient activates the rich editor while optional syntax loads.
    expect(Boolean(readComposerEditor(view.input))).toBe(kind === "recipient");
    selectComposerInput(view.input, initial.length, initial.length);
    const captured = view.capture(exact);
    expect(view.draft()).toBe(initial);
    expect(view.props.onSend).not.toHaveBeenCalled();
    const previews = [
      ...view.container.querySelectorAll<HTMLTextAreaElement>(".developer-syntax__review textarea"),
    ];
    expect(previews.map((field) => [field.value, field.dir])).toEqual([
      [exact, "auto"],
      [" \t\n ", "ltr"],
    ]);
    view.button("Insert into draft").click();
    flush();
    view.input.dispatchEvent(new FocusEvent("blur"));
    flush();
    expect(view.draft()).toBe(`${initial} \t\n `);
    expect(view.mentions()).toEqual(mentions);
    expect(view.props.onDraftChange).toHaveBeenCalledOnce();
    captured.finish(exact);
    expect(view.owner.accept()).toBe(false);
    expect(view.props.onDraftChange).toHaveBeenCalledOnce();
    expect(view.props.onSend).not.toHaveBeenCalled();
  },
);

it("uses the real rich editor transaction and keeps recipient identities through undo", async () => {
  const mention = { profileId: "alex", start: 0, end: 5 };
  const view = await fixture("@Alex hello", [mention]);
  const editor = mountMentionComposerEditor(view.input, view.mentions);
  try {
    const bridge = readComposerEditor(view.input)!;
    expect(bridge).toBeDefined();
    selectComposerInput(view.input, 6, 11);
    view.capture(exact);
    view.button("Insert into draft").click();
    flush();
    view.input.dispatchEvent(new FocusEvent("blur"));
    flush();
    expect(view.draft()).toBe("@Alex  \t\n ");
    expect(view.mentions()).toEqual([mention]);
    expect(view.container.querySelector('[data-profile-id="alex"]')).not.toBeNull();
    bridge.undo();
    flush();
    expect(view.draft()).toBe("@Alex hello");
    expect(view.mentions()).toEqual([mention]);
  } finally {
    editor.destroy();
  }
});

it.each([
  {
    kind: "native",
    content: "CR/CRLF",
    initial: "before",
    raw: "start code A windows newline B bare return C end code",
    expected: "A\r\nB\rC",
  },
  {
    kind: "rich",
    content: "CR/CRLF",
    initial: "before",
    raw: "start code A windows newline B bare return C end code",
    expected: "A\r\nB\rC",
  },
  { kind: "native", content: "whitespace-only draft", initial: "", raw: exact, expected: " \t\n " },
  { kind: "rich", content: "whitespace-only draft", initial: "", raw: exact, expected: " \t\n " },
])(
  "keeps $content copy-only for the $kind editor without losing the preview",
  async ({ kind, initial, raw, expected }) => {
    const view = await fixture(initial);
    const editor =
      kind === "rich" ? mountMentionComposerEditor(view.input, view.mentions) : undefined;
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const builtin = builtinDeveloperProfiles[0]!;
      expect(
        view.owner.importProfile(
          JSON.stringify({
            ...builtin,
            id: "windows-code",
            name: "Windows code",
            symbols: [
              ...builtin.symbols,
              { spoken: "windows newline", text: "\r\n" },
              { spoken: "bare return", text: "\r" },
            ],
          }),
        ),
      ).toBe(true);
      view.capture(raw);
      expect(view.owner.review?.text).toBe(expected);
      if (expected.includes("\r")) {
        expect(view.container.querySelector('pre[aria-label="Exact preview"]')?.textContent).toBe(
          expected,
        );
      }
      expect(view.button("Insert into draft").disabled).toBe(true);
      expect(view.button("Copy exact text").disabled).toBe(false);
      expect(view.owner.accept()).toBe(false);
      expect(view.owner.review?.text).toBe(expected);
      expect(captureDeveloperDictationTarget(view.props, view.state)!.insert(expected)).toBe(false);
      view.input.dispatchEvent(new FocusEvent("blur"));
      flush();
      view.button("Copy exact text").click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
      expect(view.draft()).toBe(initial);
      expect(view.props.onDraftChange).not.toHaveBeenCalled();
      expect(view.owner.review?.text).toBe(expected);
    } finally {
      editor?.destroy();
      if (clipboard) {
        Object.defineProperty(navigator, "clipboard", clipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  },
);

it.each(["equal draft", "profile"])(
  "revalidates the native target after a reentrant beforeinput callback changes %s",
  async (change) => {
    const view = await fixture("before");
    selectComposerInput(view.input, 6, 6);
    view.capture();
    view.input.addEventListener(
      "beforeinput",
      () => {
        if (change === "equal draft") {
          view.source.publish();
        } else {
          patchSettings({ developerDictation: { ...enabled, profileId: "en-us-json" } });
        }
      },
      { once: true },
    );
    expect(view.owner.accept()).toBe(false);
    expect(view.draft()).toBe("before");
    expect(view.props.onDraftChange).not.toHaveBeenCalled();
    expect(view.props.onSend).not.toHaveBeenCalled();
  },
);

it.each(["native", "rich"])(
  "keeps command-looking accepted bytes inert in the %s goal-capable composer",
  async (kind) => {
    const onGoalDraftModeChange = vi.fn();
    const onGoalSubmit = vi.fn(async () => false);
    const view = await fixture("/go", [], { onGoalDraftModeChange, onGoalSubmit });
    const editor =
      kind === "rich" ? mountMentionComposerEditor(view.input, view.mentions) : undefined;
    try {
      selectComposerInput(view.input, 3, 3);
      view.capture("al land it");
      view.button("Insert into draft").click();
      flush();
      expect(view.draft()).toBe("/goal land it");
      expect(onGoalDraftModeChange).not.toHaveBeenCalled();
      expect(onGoalSubmit).not.toHaveBeenCalled();
      expect(view.props.onSend).not.toHaveBeenCalled();
      // The literal transaction ends with this write; ordinary editing still owns commands.
      view.input.value = "/goal manual";
      view.input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: "l" }),
      );
      flush();
      expect(onGoalDraftModeChange).toHaveBeenCalledOnce();
      expect(view.draft()).toBe("manual");
      expect(onGoalSubmit).not.toHaveBeenCalled();
    } finally {
      editor?.destroy();
    }
  },
);

it.each(["native", "rich"])(
  "keeps an exact empty replacement empty in an active %s goal draft",
  async (kind) => {
    const onGoalDraftModeChange = vi.fn();
    const view = await fixture("objective", [], {
      onGoalDraftModeChange,
      onGoalSubmit: vi.fn(async () => false),
      goalDraftMode: { action: "start", fromCommand: true },
    });
    const editor =
      kind === "rich" ? mountMentionComposerEditor(view.input, view.mentions) : undefined;
    try {
      selectComposerInput(view.input, 0, 9);
      view.capture("start code end code");
      expect(view.owner.review?.text).toBe("");
      view.button("Insert into draft").click();
      flush();
      expect(view.draft()).toBe("");
      expect(onGoalDraftModeChange).not.toHaveBeenCalled();
      expect(view.props.onSend).not.toHaveBeenCalled();
      if (kind === "native") {
        // Chromium emits no input for an empty collapsed insertion: leave no intent behind.
        view.capture("start code end code");
        view.button("Insert into draft").click();
        flush();
        expect(view.props.onDraftChange).toHaveBeenCalledOnce();
        expect(view.state.composerInputIntentKey).toBeNull();
        expect(view.state.mentionInput).toBeUndefined();
      }
    } finally {
      editor?.destroy();
    }
  },
);

it("requires a literal choice and blocks Enter, history, and imperative send while reviewing", async () => {
  const view = await fixture("draft");
  selectComposerInput(view.input, 5, 5);
  view.capture("start code x minus y end code");
  expect(view.button("Insert into draft").disabled).toBe(true);
  for (const key of ["Enter", "ArrowUp", "ArrowDown"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    view.input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  view.state.sendDraft?.();
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(view.props.onHistoryKeydown).not.toHaveBeenCalled();
  view.button("Hyphen-minus (-)").click();
  flush();
  expect(view.owner.review?.text).toBe("x - y");
  view.button("Insert into draft").focus();
  expect(document.activeElement).toBe(view.button("Insert into draft"));
  view.button("Insert into draft").click();
  flush();
  expect(view.draft()).toBe("draftx - y");
  expect(view.props.onSend).not.toHaveBeenCalled();
});

it("keeps unsupported locales unresolved until the user explicitly retains the original", async () => {
  patchSettings({ developerDictation: { ...enabled, locale: "fr-FR" } });
  const view = await fixture();
  view.capture();
  expect(view.owner.review?.text).toBeNull();
  expect(view.button("Insert into draft").disabled).toBe(true);
  view.button("Keep recognized original").click();
  flush();
  view.button("Insert into draft").click();
  expect(view.draft()).toBe(original);
});

it.each(["oversize", "invalid Unicode"])(
  "keeps recognized-original recovery blocked for %s source",
  async (kind) => {
    const raw = kind === "oversize" ? "x".repeat(131_073) : "broken\ud800";
    const view = await fixture("kept");
    view.capture(raw);
    view.button("Keep recognized original").click();
    flush();
    expect(view.owner.review?.raw).toBe(raw);
    expect(view.owner.review?.text).toBeNull();
    expect(view.owner.review?.plan?.diagnostics[0]?.code).toBe(
      kind === "oversize" ? "limit" : "invalid",
    );
    expect(view.button("Copy exact text").disabled).toBe(true);
    expect(view.button("Insert into draft").disabled).toBe(true);
    expect(await view.owner.copy()).toBe(false);
    expect(view.owner.accept()).toBe(false);
    expect(view.draft()).toBe("kept");
    expect(view.props.onDraftChange).not.toHaveBeenCalled();
    expect(view.props.onSend).not.toHaveBeenCalled();
  },
);

it.each(["selection", "equal draft publication", "client", "permission", "profile", "disable"])(
  "rejects a final and later insertion after %s changes during provider wait",
  async (change) => {
    const view = await fixture("kept");
    selectComposerInput(view.input, 4, 4);
    const captured = view.owner.capture()!;
    if (change === "selection") {
      view.input.setSelectionRange(0, 0);
    }
    if (change === "equal draft publication") {
      view.source.publish();
    }
    if (change === "client") {
      view.props.gatewayClient = createTestGatewayClient(async () => ({}));
      renderComposerInto(view.container, view.props);
    }
    if (change === "permission") {
      view.props.canSend = false;
      renderComposerInto(view.container, view.props);
    }
    if (change === "profile") {
      patchSettings({ developerDictation: { ...enabled, profileId: "en-us-json" } });
    }
    if (change === "disable") {
      view.owner.configure({ enabled: false });
    }
    captured.finish(original);
    flush();
    expect(view.owner.review).toBeNull();
    expect(view.owner.accept()).toBe(false);
    expect(view.draft()).toBe("kept");
    expect(view.props.onDraftChange).not.toHaveBeenCalled();
    expect(view.props.onSend).not.toHaveBeenCalled();
  },
);

it("undoes the last preview edit locally and exposes literal character names without speech", async () => {
  const view = await fixture();
  view.capture("snake case first name end identifier and camel case last name end identifier");
  expect(view.owner.review?.text).toBe("first_name and lastName");
  view.button("Undo last preview transformation").click();
  flush();
  expect(view.owner.review?.text).toBe("first_name and camel case last name end identifier");
  expect(view.draft()).toBe("");
  view.container
    .querySelector<HTMLTextAreaElement>(".developer-syntax__review textarea")!
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  expect(view.owner.review).toBeNull();
  view.capture(exact);
  const inspect = [
    ...view.container.querySelectorAll<HTMLInputElement>(
      '.developer-syntax__review input[type="checkbox"]',
    ),
  ][0]!;
  inspect.click();
  flush();
  expect(view.container.textContent).toContain("tab (U+0009)");
  expect(view.container.textContent).toContain("newline (U+000A)");
});

it("retains pending profile input and an export when syntax settings are collapsed", async () => {
  const view = await fixture();
  const pending = '{"name": "profile in progress';
  const input = view.container.querySelector<HTMLTextAreaElement>(
    ".developer-syntax fieldset textarea",
  )!;
  input.value = pending;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: pending }));
  view.button("Show profile export").click();
  flush();
  const exported = () =>
    view.container.querySelector<HTMLTextAreaElement>(
      ".developer-syntax details textarea[readonly]",
    );
  expect(JSON.parse(exported()!.value).id).toBe("en-us-plain-code");
  const details = view.container.querySelector<HTMLDetailsElement>(".developer-syntax details")!;
  for (const open of [false, true]) {
    const toggled = new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.querySelector<HTMLElement>("summary")!.click();
    await toggled;
    flush();
    expect(details.open).toBe(open);
  }
  expect(
    view.container.querySelector<HTMLTextAreaElement>(".developer-syntax fieldset textarea")!.value,
  ).toBe(pending);
  expect(JSON.parse(exported()!.value).id).toBe("en-us-plain-code");
});

it("retains authored bytes on disable or failed import and checks a newer persisted revision", async () => {
  const view = await fixture();
  const profile = { ...builtinDeveloperProfiles[0]!, id: "my-code", name: "My code", revision: 1 };
  const authored = JSON.stringify(profile, null, 2);
  expect(view.owner.importProfile(authored)).toBe(true);
  view.owner.configure({ enabled: false });
  expect((loadSettings().developerDictation as DeveloperDictationSettings).profiles).toEqual([
    authored,
  ]);
  expect(view.owner.importProfile('{"schemaVersion":99}')).toBe(false);
  expect((loadSettings().developerDictation as DeveloperDictationSettings).profiles).toEqual([
    authored,
  ]);
  const otherPane = JSON.stringify({ ...profile, revision: 3 });
  patchSettings({
    developerDictation: { ...enabled, profileId: profile.id, profiles: [otherPane] },
  });
  expect(view.owner.importProfile(JSON.stringify({ ...profile, revision: 2 }))).toBe(false);
  expect((loadSettings().developerDictation as DeveloperDictationSettings).profiles).toEqual([
    otherPane,
  ]);
  expect(JSON.parse(view.owner.exportProfile()).revision).toBe(3);
});

it("preserves unknown saved records and requires an explicit Prose fallback", async () => {
  const future = { schemaVersion: 99, authored: "Keep me" };
  patchSettings({ developerDictation: future });
  const view = await fixture();
  view.capture();
  expect(view.owner.review?.text).toBeNull();
  expect(JSON.parse(view.owner.exportProfile())).toEqual(future);
  view.button("Use Prose for this session").click();
  expect(view.owner.capture()).toBeUndefined();
  expect(loadSettings().developerDictation).toEqual(future);
});

it.each([{ enabled: false }, { mode: "prose" as const }])(
  "keeps explicit baseline dictation available with unused invalid profile data: %j",
  async (baseline) => {
    const saved = { ...enabled, ...baseline, profiles: ["not a profile"] };
    patchSettings({ developerDictation: saved });
    const view = await fixture();
    expect(view.owner.invalidSettings).toBe(true);
    expect(view.owner.capture()).toBeUndefined();
    expect(view.owner.blocksSend).toBe(false);
    expect(loadSettings().developerDictation).toEqual(saved);
  },
);

it("retires an uncertain editor write and never retries or restores its captured baseline", () => {
  let draft = "before";
  const insert = vi.fn(() => {
    draft = "partially written";
    throw new Error("host failed after writing");
  });
  const owner = new ComposerDeveloperSyntax({
    readSettings: () => enabled,
    saveSettings: vi.fn(),
    cancelCapture: vi.fn(),
    captureTarget: () => ({ isCurrent: () => true, insert }),
    copy: vi.fn(),
  });
  owner.capture()!.finish(original);
  expect(owner.accept()).toBe(false);
  expect(owner.accept()).toBe(false);
  expect(insert).toHaveBeenCalledOnce();
  expect(draft).toBe("partially written");
  expect(owner.blocksSend).toBe(false);
  expect(owner.notice).toContain("could not confirm insertion");
});
