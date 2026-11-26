// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceComposerInputWithHistory } from "./composer-input.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function field() {
  const input = document.createElement("textarea");
  input.value = "original draft";
  document.body.append(input);
  const command = vi.fn(() => true);
  Object.defineProperty(document, "queryCommandSupported", {
    configurable: true,
    value: () => true,
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  return { input, command };
}

describe("reviewed composer history transaction", () => {
  it("revalidates after focus handlers change the draft or revoke the request", () => {
    const { input, command } = field();
    let current = true;
    input.addEventListener("focus", () => {
      input.value = "newer user draft";
      current = false;
    });
    expect(replaceComposerInputWithHistory(input, "stale replacement", () => current)).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(input.value).toBe("newer user draft");
  });

  it.each([true, false])(
    "reports the single native attempt without retrying when API success is %s",
    (reported) => {
      const { input, command } = field();
      command.mockImplementation(() => {
        input.value = "reviewed text";
        return reported;
      });
      const rawReplacement = vi.spyOn(input, "setRangeText");
      expect(replaceComposerInputWithHistory(input, "reviewed text", () => true)).toBe(
        reported ? true : undefined,
      );
      expect(command).toHaveBeenCalledExactlyOnceWith("insertText", false, "reviewed text");
      expect(rawReplacement).not.toHaveBeenCalled();
      expect(input.value).toBe("reviewed text");
    },
  );

  it("keeps original text when no qualified history command exists", () => {
    const { input, command } = field();
    Object.defineProperty(document, "queryCommandSupported", {
      configurable: true,
      value: () => false,
    });
    expect(replaceComposerInputWithHistory(input, "replacement", () => true)).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(input.value).toBe("original draft");
  });
});
