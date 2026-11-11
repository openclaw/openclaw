import { CANCEL_SYMBOL, symbol, type SpinnerOptions } from "@clack/prompts";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type MockInstance,
} from "vitest";

const themeMocks = vi.hoisted(() => ({
  isRich: vi.fn(() => false),
}));

const ttyMock = createCliTtyMock([process.stdout]);
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const initialSuiteResizeListeners = process.stdout.listeners("resize");

afterAll(() => {
  expect(process.stdout.listeners("resize")).toEqual(initialSuiteResizeListeners);
});

const stubStdoutIsTTY = ttyMock.set;

function stubStdoutColumns(value: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", { configurable: true, value });
}

const cliProgressMocks = vi.hoisted(() => ({
  createCliProgress: vi.fn(() => ({
    done: vi.fn(),
    setLabel: vi.fn(),
  })),
}));

const terminalNoteMocks = vi.hoisted(() => ({
  note: vi.fn(),
}));

const clackMocks = vi.hoisted(() => ({
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  multiselect: vi.fn(),
  outro: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  settings: { actions: new Set(["left", "right"]) },
  spinner: vi.fn((_options?: SpinnerOptions) => ({
    start: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
  })),
  text: vi.fn(),
}));

const navigationPromptMocks = vi.hoisted(() => ({
  autocompleteMultiselectWithNavigationFooter: vi.fn(),
  autocompleteWithNavigationFooter: vi.fn(),
  confirmWithNavigationFooter: vi.fn(),
  multiselectWithNavigationFooter: vi.fn(),
  passwordWithNavigationFooter: vi.fn(),
  selectWithNavigationFooter: vi.fn(),
  textWithNavigationFooter: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>()),
  isRich: themeMocks.isRich,
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  ...clackMocks,
}));

vi.mock("../cli/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/progress.js")>()),
  createCliProgress: cliProgressMocks.createCliProgress,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  noteToStream: terminalNoteMocks.note,
}));

vi.mock("./clack-navigation-prompts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clack-navigation-prompts.js")>()),
  ...navigationPromptMocks,
}));

import {
  stylePromptHint,
  stylePromptMessage,
} from "../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";
import type { WizardPromptNavigation, WizardSelectOption } from "./prompts.js";
import { WizardCancelledError, WizardNavigationError } from "./prompts.js";

function expectStdinRestored() {
  const end = process.stdin.listeners("end");
  const keypress = process.stdin.listeners("keypress");
  return () => {
    expect(process.stdin.listeners("end")).toEqual(end);
    expect(process.stdin.listeners("keypress")).toEqual(keypress);
  };
}

async function cancelOnAbort({ signal }: { signal?: AbortSignal }) {
  return await new Promise<symbol>((resolve) => {
    signal?.addEventListener("abort", () => resolve(CANCEL_SYMBOL), { once: true });
  });
}

function startProgress(label = "Loading") {
  const progress = createClackPrompter().progress(label);
  onTestFinished(() => progress.stop());
  return { progress, spin: clackMocks.spinner.mock.results[0]!.value };
}

function stubInteractiveTerminal(rich = true) {
  stubStdoutIsTTY(true);
  vi.stubEnv("CI", "");
  vi.stubEnv("VITEST", "");
  themeMocks.isRich.mockReturnValue(rich);
}

const promptCases = [
  {
    label: "select",
    mock: clackMocks.select,
    navigationMock: navigationPromptMocks.selectWithNavigationFooter,
    actions: ["left", "right", "up"],
    value: "one",
    run: (p: ReturnType<typeof createClackPrompter>, navigation?: WizardPromptNavigation) =>
      p.select({ message: "Provider", options: [{ value: "one", label: "One" }], navigation }),
  },
  {
    label: "multiselect",
    mock: clackMocks.multiselect,
    navigationMock: navigationPromptMocks.multiselectWithNavigationFooter,
    actions: ["left", "up"],
    value: ["one"],
    run: (p: ReturnType<typeof createClackPrompter>, navigation?: WizardPromptNavigation) =>
      p.multiselect({ message: "Options", options: [{ value: "one", label: "One" }], navigation }),
  },
  {
    label: "confirm",
    mock: clackMocks.confirm,
    navigationMock: navigationPromptMocks.confirmWithNavigationFooter,
    actions: ["right", "up"],
    value: true,
    expected: {
      message: expect.stringContaining("Continue?"),
      initialValue: undefined,
      vertical: true,
    },
    run: (p: ReturnType<typeof createClackPrompter>, navigation?: WizardPromptNavigation) =>
      p.confirm({ message: "Continue?", layout: "vertical", navigation }),
  },
  {
    label: "text",
    mock: clackMocks.text,
    navigationMock: navigationPromptMocks.textWithNavigationFooter,
    actions: ["up"],
    value: "label",
    expected: {
      message: expect.stringContaining("Workspace"),
      initialValue: "~/.openclaw/workspace",
      placeholder: "path",
    },
    run: (p: ReturnType<typeof createClackPrompter>, navigation?: WizardPromptNavigation) =>
      p.text({
        message: "Workspace",
        initialValue: "~/.openclaw/workspace",
        placeholder: "path",
        navigation,
      }),
  },
  {
    label: "password",
    mock: clackMocks.password,
    navigationMock: navigationPromptMocks.passwordWithNavigationFooter,
    actions: ["up"],
    value: "secret",
    expected: { message: expect.stringContaining("API key") },
    run: (p: ReturnType<typeof createClackPrompter>, navigation?: WizardPromptNavigation) =>
      p.text({ message: "API key", sensitive: true, navigation }),
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  ttyMock.restore();
  if (stdoutColumnsDescriptor) {
    Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "columns");
  }
  themeMocks.isRich.mockReturnValue(false);
  clackMocks.settings.actions = new Set(["left", "right"]);
});

describe("tokenizedOptionFilter", () => {
  const option = { value: "openai/gpt-5.4", label: "GPT 5.4", hint: "provider openai" };
  it("matches tokens regardless of order", () => {
    expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    expect(tokenizedOptionFilter("gpt-5.4 anthropic/", { ...option, hint: undefined })).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
  });
});

describe("createClackPrompter", () => {
  let stdoutWriteSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  it("clamps long progress labels by display width without splitting grapheme clusters", () => {
    stubStdoutColumns(20);
    const { progress, spin } = startProgress("12345678😀ABC");
    progress.update("正在扫描已安装应用…");
    progress.stop("1234567890ABC");

    const osc = cliProgressMocks.createCliProgress.mock.results[0]!.value;
    expect(spin.start).toHaveBeenCalledWith(theme.accent("12345678…"));
    expect(spin.message).toHaveBeenCalledWith(theme.accent("正在扫描…"));
    expect(cliProgressMocks.createCliProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "12345678😀ABC" }),
    );
    expect(osc.setLabel).toHaveBeenCalledWith("正在扫描已安装应用…");
  });

  it("preserves emoji joined by zero-width joiners when truncating", () => {
    stubStdoutColumns(14);
    const { spin } = startProgress("👨‍👩‍👧‍👦ABCDEFGH");
    expect(spin.start).toHaveBeenCalledWith(theme.accent("👨‍👩‍👧‍👦A…"));
  });

  it("shrinks active progress labels without expanding past the initial width", () => {
    stubStdoutColumns(20);
    const initialResizeListeners = process.stdout.listenerCount("resize");
    const { progress, spin } = startProgress("123456789ABC");
    stubStdoutColumns(14);
    process.stdout.emit("resize");
    stubStdoutColumns(30);
    process.stdout.emit("resize");
    progress.update("ABCDEFGHIJK");
    progress.stop();

    expect(spin.message).toHaveBeenNthCalledWith(1, theme.accent("123…"));
    expect(spin.message).toHaveBeenNthCalledWith(2, theme.accent("ABC…"));
    expect(process.stdout.listenerCount("resize")).toBe(initialResizeListeners);
  });

  it("leaves progress labels untouched when terminal columns are unavailable", () => {
    stubStdoutColumns(undefined);
    const { spin } = startProgress("1234567890ABC");
    expect(spin.start).toHaveBeenCalledWith(theme.accent("1234567890ABC"));
  });

  it.each([undefined, "", "First line\nSecond line"])(
    "preserves tiny completion %j once",
    (message) => {
      stubInteractiveTerminal();
      stubStdoutColumns(6);
      const { progress, spin } = startProgress();

      expect(spin.start).not.toHaveBeenCalled();
      progress.update("Still loading");
      progress.stop(message);
      const expected = message === undefined ? [] : [[`${symbol("submit")}  ${message}\n`]];
      expect(stdoutWriteSpy.mock.calls).toEqual(expected);
      progress.stop("Unexpected second completion");
      expect(stdoutWriteSpy.mock.calls).toEqual(expected);
      expect(process.stdout.listeners("resize")).toEqual(initialSuiteResizeListeners);
    },
  );

  it("keeps completion after clearing tiny animation", () => {
    stubStdoutColumns(20);
    const { progress, spin } = startProgress();
    stubStdoutColumns(6);
    process.stdout.emit("resize");
    expect(spin.clear).toHaveBeenCalled();
    stubStdoutColumns(30);
    process.stdout.emit("resize");
    progress.update("Still loading");
    expect(spin.start).toHaveBeenCalledTimes(1);

    progress.stop("Finished after resize");
    expect(stdoutWriteSpy).toHaveBeenCalledWith(`${symbol("submit")}  Finished after resize\n`);
  });

  it.each([false, true])("selects the interactive spinner (rich: %s)", (rich) => {
    stubInteractiveTerminal(rich);
    startProgress();
    expect(clackMocks.spinner).toHaveBeenCalledWith({
      ...(rich
        ? { frames: ["(\\/)", "(||)", "(--)", "(||)"], delay: 120, styleFrame: theme.accent }
        : {}),
      output: process.stdout,
    });
  });

  it("routes Clack UI, prompts, notes, plain text, and progress to the selected output", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    clackMocks.confirm.mockResolvedValue(true);
    const prompter = createClackPrompter(process.stderr);

    await prompter.intro("Add agent");
    await prompter.note("Details", "Agent");
    await prompter.plain?.("plain");
    await expect(prompter.confirm({ message: "Continue?", layout: "vertical" })).resolves.toBe(
      true,
    );
    await prompter.outro("Ready");
    const progress = prompter.progress("Loading");
    progress.update("Still loading");
    progress.stop();

    expect(clackMocks.intro).toHaveBeenCalledWith(expect.any(String), {
      output: process.stderr,
    });
    expect(terminalNoteMocks.note).toHaveBeenCalledWith("Details", "Agent", process.stderr);
    expect(stderrWrite).toHaveBeenCalledWith("plain\n");
    expect(clackMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ output: process.stderr, initialValue: undefined, vertical: true }),
    );
    expect(clackMocks.select).not.toHaveBeenCalled();
    expect(clackMocks.outro).toHaveBeenCalledWith(expect.any(String), {
      output: process.stderr,
    });
    expect(clackMocks.spinner).toHaveBeenCalledWith({ output: process.stderr });
    expect(cliProgressMocks.createCliProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stream: process.stderr }),
    );
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });

  describe.each(["select", "multiselect"] as const)("%s request routing", (method) => {
    it.each([
      { searchable: false, withNavigation: false },
      { searchable: true, withNavigation: false },
      { searchable: false, withNavigation: true },
      { searchable: true, withNavigation: true },
    ])("preserves request values for %j", async ({ searchable, withNavigation }) => {
      const value = Symbol("clack:cancel");
      const objectValue = { id: "object-option" };
      const options: WizardSelectOption<symbol | typeof objectValue>[] = [
        { value, label: "Symbol option" },
        { value: objectValue, label: "Object option", hint: "object hint" },
      ];
      const initialValues = [value, objectValue];
      const navigation = withNavigation ? { canGoBack: false, canGoForward: false } : undefined;
      const backends =
        method === "select"
          ? [
              clackMocks.select,
              clackMocks.autocomplete,
              navigationPromptMocks.selectWithNavigationFooter,
              navigationPromptMocks.autocompleteWithNavigationFooter,
            ]
          : [
              clackMocks.multiselect,
              clackMocks.autocompleteMultiselect,
              navigationPromptMocks.multiselectWithNavigationFooter,
              navigationPromptMocks.autocompleteMultiselectWithNavigationFooter,
            ];
      const backend = backends[Number(withNavigation) * 2 + Number(searchable)]!;
      const params = { message: "Pick options", options, searchable, navigation };
      const owner = new AbortController();
      const prompter = createClackPrompter(process.stderr, owner.signal);
      const run = () =>
        method === "select"
          ? prompter.select({ ...params, initialValue: value })
          : prompter.multiselect({ ...params, initialValues });
      const selected = method === "select" ? value : initialValues;
      backend.mockResolvedValueOnce(selected);

      await expect(run()).resolves.toBe(selected);
      expect(backend).toHaveBeenCalledOnce();
      const request = backend.mock.calls[0]?.[0];
      expect(request).toEqual({
        message: stylePromptMessage(params.message),
        options: [options[0], { ...options[1], hint: stylePromptHint("object hint") }],
        ...(method === "select" ? { initialValue: value } : { initialValues }),
        ...(searchable ? { filter: tokenizedOptionFilter } : {}),
        signal: expect.any(AbortSignal),
        ...(navigation ? { navigation } : {}),
        output: process.stderr,
      });
      expect(request.options[0]).toBe(options[0]);
      expect(request.options[1].value).toBe(objectValue);
      expect(options[1]?.hint).toBe("object hint");
      if (method === "multiselect") {
        expect(request.initialValues).toBe(initialValues);
      }
      expect(request.signal.aborted).toBe(false);
      expect(clackMocks.settings.actions).toEqual(new Set(["left", "right"]));
      owner.abort();
      expect(request.signal.aborted).toBe(true);
      expect(clackMocks.cancel).not.toHaveBeenCalled();

      backend.mockResolvedValueOnce(CANCEL_SYMBOL);
      await expect(run()).rejects.toBeInstanceOf(WizardCancelledError);
      expect(clackMocks.cancel).not.toHaveBeenCalled();
    });
  });

  it.each(promptCases)(
    "restores prior cursor actions after $label completion",
    async ({ navigationMock: mock, mock: ordinary, label, value, run, actions, expected }) => {
      const navigation = {
        canGoBack: true,
        canGoForward: label === "text" || label === "password",
      };
      clackMocks.settings.actions = new Set(actions);
      const initialEndListeners = process.stdin.listeners("end");
      const initialKeypressListeners = process.stdin.listeners("keypress");
      mock.mockImplementation(async () => {
        expect(clackMocks.settings.actions).toEqual(new Set(["up"]));
        expect(process.stdin.listenerCount("end")).toBe(initialEndListeners.length + 1);
        expect(process.stdin.listenerCount("keypress")).toBe(initialKeypressListeners.length + 1);
        return value;
      });

      await expect(run(createClackPrompter(), navigation)).resolves.toEqual(value);

      expect(mock).toHaveBeenCalledOnce();
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({
          ...expected,
          navigation,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(ordinary).not.toHaveBeenCalled();
      if (label === "confirm") {
        expect(clackMocks.select).not.toHaveBeenCalled();
      }
      expect(clackMocks.settings.actions).toEqual(new Set(actions));
      expect(process.stdin.listeners("end")).toEqual(initialEndListeners);
      expect(process.stdin.listeners("keypress")).toEqual(initialKeypressListeners);
    },
  );

  it("cleans up a throwing navigation prompt after queued EOF", async () => {
    const failure = new Error("prompt failed");
    const assertRestored = expectStdinRestored();
    clackMocks.settings.actions = new Set(["left", "up"]);
    let promptSignal: AbortSignal | undefined;
    navigationPromptMocks.textWithNavigationFooter.mockImplementation(({ signal }) => {
      promptSignal = signal;
      expect(clackMocks.settings.actions).toEqual(new Set(["up"]));
      process.stdin.emit("end");
      throw failure;
    });

    await expect(
      createClackPrompter().text({ message: "Label", navigation: { canGoBack: true } }),
    ).rejects.toBe(failure);

    expect(clackMocks.settings.actions).toEqual(new Set(["left", "up"]));
    assertRestored();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(promptSignal?.aborted).toBe(false);
  });

  it.each(promptCases)(
    "cancels $label input silently when its owner completes or disconnects",
    async ({ mock, run }) => {
      const controller = new AbortController();
      const assertRestored = expectStdinRestored();
      mock.mockImplementation(cancelOnAbort);
      const prompt = run(createClackPrompter(process.stderr, controller.signal));
      controller.abort();

      await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
      expect(clackMocks.cancel).not.toHaveBeenCalled();
      expect(mock.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      assertRestored();
    },
  );

  it.each(["owner", "text"])(
    "preserves both cancellation owners for a text prompt: %s",
    async (cancelOwner) => {
      const owner = new AbortController();
      const text = new AbortController();
      clackMocks.text.mockImplementation(cancelOnAbort);
      const prompt = createClackPrompter(process.stderr, owner.signal).text({
        message: "Label",
        signal: text.signal,
      });
      (cancelOwner === "owner" ? owner : text).abort();
      await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
      expect(clackMocks.cancel).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "turns stdin EOF into wizard cancellation (navigation: %s)",
    async (navigation) => {
      const entry = promptCases[navigation ? 0 : 2]!;
      const mock = navigation ? entry.navigationMock : entry.mock;
      const assertRestored = expectStdinRestored();
      mock.mockImplementation(cancelOnAbort);

      const prompt = entry.run(
        createClackPrompter(),
        navigation ? { canGoBack: true, canGoForward: false } : undefined,
      );
      await Promise.resolve();
      process.stdin.emit("end");

      await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
      assertRestored();
    },
  );

  it.each([false, true])(
    "lets Clack finalize before the wrapper fallback (piped input: %s)",
    async (piped) => {
      const assertRestored = expectStdinRestored();
      const finalize = vi.fn();
      clackMocks.confirm.mockImplementation(
        async ({ signal }: { signal?: AbortSignal }) =>
          await new Promise<true | symbol>((resolve) => {
            const finish = () => {
              finalize();
              if (!piped) {
                process.stdin.off("keypress", onClackKeypress);
              }
              resolve(piped ? true : CANCEL_SYMBOL);
            };
            const onClackKeypress = (input: string | undefined) => {
              if (input === "\x04") {
                finish();
              }
            };
            if (piped) {
              process.stdin.once("end", finish);
            } else {
              process.stdin.on("keypress", onClackKeypress);
            }
            signal?.addEventListener("abort", piped ? finalize : finish, { once: true });
          }),
      );

      const prompt = createClackPrompter().confirm({ message: "Continue?" });
      await Promise.resolve();
      if (piped) {
        process.stdin.emit("data", "y\n");
        process.stdin.emit("end");
        await expect(prompt).resolves.toBe(true);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      } else {
        process.stdin.emit("keypress", "\x04", { ctrl: true, name: "d" });
        await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
      }
      expect(finalize).toHaveBeenCalledOnce();
      assertRestored();
    },
  );

  it.each([false, true])(
    "keeps Ctrl-C cancellation on Clack's canonical path (navigation: %s)",
    async (navigation) => {
      const mock = navigation
        ? navigationPromptMocks.confirmWithNavigationFooter
        : clackMocks.confirm;
      mock.mockResolvedValue(CANCEL_SYMBOL);
      clackMocks.cancel.mockImplementationOnce(() => {
        expect(clackMocks.settings.actions.has("left")).toBe(!navigation);
        expect(clackMocks.settings.actions.has("right")).toBe(!navigation);
      });

      await expect(
        createClackPrompter().confirm({
          message: "Continue?",
          ...(navigation ? { navigation: { canGoBack: true } } : {}),
        }),
      ).rejects.toBeInstanceOf(WizardCancelledError);

      expect(clackMocks.cancel).toHaveBeenCalledOnce();
      expect(clackMocks.cancel).toHaveBeenCalledWith(expect.any(String), {
        output: process.stdout,
      });
      expect(clackMocks.settings.actions).toEqual(new Set(["left", "right"]));
    },
  );

  it("rejects navigation after Clack resolves an aborted prompt", async () => {
    navigationPromptMocks.textWithNavigationFooter.mockImplementation(cancelOnAbort);
    const prompter = createClackPrompter();

    const result = prompter.text({
      message: "Workspace",
      navigation: { canGoBack: false, canGoForward: true },
    });
    await Promise.resolve();
    process.stdin.emit("keypress", undefined, { name: "right" });

    await expect(result).rejects.toMatchObject({
      direction: "forward",
    } satisfies Partial<WizardNavigationError>);
    expect(clackMocks.settings.actions).toEqual(new Set(["left", "right"]));
  });

  it("keeps text cursor actions when prompt navigation has no available move", async () => {
    navigationPromptMocks.textWithNavigationFooter.mockImplementation(async () => {
      expect(clackMocks.settings.actions.has("left")).toBe(true);
      expect(clackMocks.settings.actions.has("right")).toBe(true);
      return "workspace";
    });
    const prompter = createClackPrompter();

    await expect(
      prompter.text({
        message: "Workspace",
        navigation: { canGoBack: false, canGoForward: false },
      }),
    ).resolves.toBe("workspace");

    expect(navigationPromptMocks.textWithNavigationFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        navigation: { canGoBack: false, canGoForward: false },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
