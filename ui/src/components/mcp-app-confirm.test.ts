import { render } from "lit";
import { afterEach, expect, it } from "vitest";
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

it("keeps confirm preview text valid when the 200-unit boundary bisects an emoji", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const confirmation = new McpAppConfirm(() => {
    render(confirmation.render(), root);
  });
  const text = `${"a".repeat(199)}😀`;
  expect(text.length).toBe(201);
  const rawSlice = `${text.slice(0, 200)}…`;
  expect(hasLoneUtf16Surrogate(text.slice(0, 200))).toBe(true);
  expect(hasLoneUtf16Surrogate(rawSlice)).toBe(true);
  console.log(
    `[mcp-app-confirm unicode proof] phase=before raw_slice_lone=true raw_len=${rawSlice.length}`,
  );

  const decision = confirmation.request({
    frame,
    title: "Unicode preview",
    text,
    kind: "message",
    isCurrent: () => true,
  });
  const dialog = root.querySelector<HTMLElement>('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  const preview = dialog!.querySelector<HTMLElement>(".mcp-app-confirm__preview");
  expect(preview).not.toBeNull();
  const shown = (preview!.textContent ?? "").trim();
  console.log(
    `[mcp-app-confirm unicode proof] raw_slice_lone=${hasLoneUtf16Surrogate(text.slice(0, 200))} preview_lone=${hasLoneUtf16Surrogate(shown)} preview_has_replacement=${shown.includes("\uFFFD")} preview_len=${shown.length} ends_with_ellipsis=${shown.endsWith("…")}`,
  );
  expect(hasLoneUtf16Surrogate(shown)).toBe(false);
  expect(shown.includes("\uFFFD")).toBe(false);
  expect(shown.endsWith("…")).toBe(true);
  expect(shown.length).toBeLessThanOrEqual(201);
  expect(preview!.getAttribute("title")).toBe(text);
  confirmation.cancel();
  await decision;
});
