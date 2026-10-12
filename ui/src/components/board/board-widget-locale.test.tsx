import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../../i18n/lib/translate.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { BoardPendingCapabilities } from "./board-widget-capabilities.solid.tsx";

it("updates a mounted approval label when the locale changes", async () => {
  const previousLocale = i18n.getLocale();
  const translate = i18n.t.bind(i18n);
  const translation = vi
    .spyOn(i18n, "t")
    .mockImplementation((key, params) =>
      key === "board.widget.needsApproval"
        ? `Approval (${i18n.getLocale()})`
        : translate(key, params),
    );
  onTestFinished(async () => {
    translation.mockRestore();
    await i18n.setLocale(previousLocale);
  });
  await i18n.setLocale("en");
  const widget: BoardWidget = {
    name: "fixture",
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    revision: 1,
    grantState: "pending",
  };
  const mounted = mountSolid(() => (
    <BoardPendingCapabilities widget={widget} disabled={false} onGrant={() => {}} />
  ));
  const label = mounted.container.querySelector("strong")!;
  expect(label.textContent).toBe("Approval (en)");
  await i18n.setLocale("de");
  flush();
  expect(label.textContent).toBe("Approval (de)");
});
