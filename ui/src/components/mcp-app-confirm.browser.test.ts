// Real Control UI Chromium proof: mount production McpAppConfirm and screenshot the confirm strip.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import { McpAppConfirm } from "./mcp-app-confirm.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("MCP App confirm Unicode preview (Control UI Chromium)", () => {
  it("paints a clean confirm preview when the 200-unit boundary bisects an emoji", async () => {
    document.documentElement.dataset.themeMode = "dark";
    document.body.style.margin = "0";
    document.body.style.padding = "24px";
    document.body.style.background = "#0f1115";

    const text = `${"a".repeat(199)}😀`;
    expect(text.length).toBe(201);
    const rawSlice = `${text.slice(0, 200)}…`;
    expect(hasLoneUtf16Surrogate(rawSlice)).toBe(true);

    const beforeRoot = document.createElement("section");
    beforeRoot.setAttribute("aria-label", "before");
    beforeRoot.innerHTML =
      '<div class="label" style="font:12px sans-serif;color:#9aa0a6;margin-bottom:6px">Before (raw UTF-16 slice at 200)</div>';
    const beforePreview = document.createElement("div");
    beforePreview.className = "mcp-app-confirm__preview";
    beforePreview.dataset.proof = "before";
    beforePreview.title = text;
    beforePreview.textContent = rawSlice;
    beforePreview.style.cssText =
      "margin-top:4px;color:#9aa0a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:640px;padding:12px 14px;border:1px solid #3c4048;border-radius:10px;background:#1a1d24";
    beforeRoot.append(beforePreview);

    const afterRoot = document.createElement("section");
    afterRoot.setAttribute("aria-label", "after");
    const afterLabel = document.createElement("div");
    afterLabel.textContent = "After (production McpAppConfirm preview)";
    afterLabel.style.cssText = "font:12px sans-serif;color:#9aa0a6;margin:16px 0 6px";
    afterRoot.append(afterLabel);
    const afterHost = document.createElement("div");
    afterRoot.append(afterHost);

    const frame = document.createElement("iframe");
    document.body.append(beforeRoot, afterRoot, frame);

    const confirmation = new McpAppConfirm(() => {
      render(confirmation.render(), afterHost);
    });
    const decision = confirmation.request({
      frame,
      title: "Unicode preview",
      text,
      kind: "message",
      isCurrent: () => true,
    });

    const dialog = afterHost.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    const preview = dialog!.querySelector<HTMLElement>(".mcp-app-confirm__preview");
    expect(preview).not.toBeNull();
    const shown = (preview!.textContent ?? "").trim();
    expect(hasLoneUtf16Surrogate(shown)).toBe(false);
    expect(shown.includes("\uFFFD")).toBe(false);
    expect(shown.endsWith("…")).toBe(true);

    // Media proof: Chromium paints the production confirm strip (and the broken raw slice above it).
    const stripShot = await page.screenshot({ save: true });
    const previewShot = await page.elementLocator(preview!).screenshot({ save: true });
    console.log(
      `[mcp-app-confirm unicode Chromium proof] renderer=McpAppConfirm raw_slice_lone=true preview_lone=false preview_has_replacement=false preview_len=${shown.length} ends_with_ellipsis=true strip_shot_chars=${String(stripShot).length} preview_shot_chars=${String(previewShot).length}`,
    );

    confirmation.cancel();
    await decision;
  });
});
