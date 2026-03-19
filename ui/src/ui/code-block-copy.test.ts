import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodeBlockCopyClick } from "./code-block-copy.ts";

describe("handleCodeBlockCopyClick", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("copies code from a clicked code-block button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    document.body.innerHTML = `
      <div class="sidebar-markdown">
        <button type="button" class="code-block-copy" data-code="console.log('copied')">
          <span>Copy</span>
        </button>
      </div>
    `;

    const button = document.querySelector<HTMLButtonElement>(".code-block-copy");
    expect(button).not.toBeNull();

    const event = new MouseEvent("click", { bubbles: true });
    button?.dispatchEvent(event);
    handleCodeBlockCopyClick(event);

    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("console.log('copied')");
    expect(button?.classList.contains("copied")).toBe(true);
  });
});
