import { afterEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.hoisted(() => vi.fn());
const multiselectMock = vi.hoisted(() => vi.fn());
const autocompleteMultiselectMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const introMock = vi.hoisted(() => vi.fn());
const outroMock = vi.hoisted(() => vi.fn());
const textMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const spinnerStartMock = vi.hoisted(() => vi.fn());
const spinnerMessageMock = vi.hoisted(() => vi.fn());
const spinnerStopMock = vi.hoisted(() => vi.fn());

vi.mock("@clack/prompts", () => ({
  autocompleteMultiselect: autocompleteMultiselectMock,
  cancel: cancelMock,
  confirm: confirmMock,
  intro: introMock,
  isCancel: () => false,
  multiselect: multiselectMock,
  outro: outroMock,
  select: selectMock,
  spinner: () => ({
    start: spinnerStartMock,
    message: spinnerMessageMock,
    stop: spinnerStopMock,
  }),
  text: textMock,
}));

import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";

describe("createClackPrompter", () => {
  afterEach(() => {
    selectMock.mockReset();
    multiselectMock.mockReset();
    autocompleteMultiselectMock.mockReset();
    confirmMock.mockReset();
    introMock.mockReset();
    outroMock.mockReset();
    textMock.mockReset();
    cancelMock.mockReset();
    spinnerStartMock.mockReset();
    spinnerMessageMock.mockReset();
    spinnerStopMock.mockReset();
  });

  it("falls back to the option value when select labels are blank", async () => {
    selectMock.mockResolvedValue("telegram");
    const prompter = createClackPrompter();

    await prompter.select({
      message: "Select channel",
      options: [
        {
          value: "telegram",
          label: "   ",
        },
      ],
    });

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            value: "telegram",
            label: "telegram",
          }),
        ],
      }),
    );
  });

  it("falls back to the option value when multiselect labels are blank", async () => {
    multiselectMock.mockResolvedValue(["signal"]);
    const prompter = createClackPrompter();

    await prompter.multiselect({
      message: "Select channels",
      options: [
        {
          value: "signal",
          label: "",
        },
      ],
    });

    expect(multiselectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            value: "signal",
            label: "signal",
          }),
        ],
      }),
    );
  });

  it("preserves non-empty labels", async () => {
    selectMock.mockResolvedValue("telegram");
    const prompter = createClackPrompter();

    await prompter.select({
      message: "Select channel",
      options: [
        {
          value: "telegram",
          label: "Telegram",
        },
      ],
    });

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            value: "telegram",
            label: "Telegram",
          }),
        ],
      }),
    );
  });

  it("preserves padded non-empty labels unchanged", async () => {
    selectMock.mockResolvedValue("telegram");
    const prompter = createClackPrompter();

    await prompter.select({
      message: "Select channel",
      options: [
        {
          value: "telegram",
          label: "  Telegram  ",
        },
      ],
    });

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            value: "telegram",
            label: "  Telegram  ",
          }),
        ],
      }),
    );
  });
});

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
    };

    expect(tokenizedOptionFilter("gpt-5.4 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "GPT 5.4",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
  });
});
