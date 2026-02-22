import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock, stylePromptMessageMock, stylePromptHintMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  stylePromptMessageMock: vi.fn((value: string) => `msg:${value}`),
  stylePromptHintMock: vi.fn((value: string) => `hint:${value}`),
}));

vi.mock("@clack/prompts", () => ({
  select: selectMock,
}));

vi.mock("./prompt-style.js", () => ({
  stylePromptMessage: stylePromptMessageMock,
  stylePromptHint: stylePromptHintMock,
}));

import { selectStyled } from "./prompt-select-styled.js";

describe("selectStyled", () => {
  beforeEach(() => {
    selectMock.mockReset();
    stylePromptMessageMock.mockClear();
    stylePromptHintMock.mockClear();
  });

  it("styles message and option hints before delegating to clack select", () => {
    const expected = Symbol("selected");
    selectMock.mockReturnValue(expected);

    const result = selectStyled({
      message: "Pick channel",
      options: [
        { value: "stable", label: "Stable", hint: "Tagged releases" },
        { value: "dev", label: "Dev" },
      ],
    });

    expect(result).toBe(expected);
    expect(stylePromptMessageMock).toHaveBeenCalledWith("Pick channel");
    expect(stylePromptHintMock).toHaveBeenCalledWith("Tagged releases");
    expect(selectMock).toHaveBeenCalledWith({
      message: "msg:Pick channel",
      options: [
        { value: "stable", label: "Stable", hint: "hint:Tagged releases" },
        { value: "dev", label: "Dev" },
      ],
    });
  });
});
