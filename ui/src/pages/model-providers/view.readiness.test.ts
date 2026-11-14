/* @vitest-environment jsdom */
import { getByRole } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mount, props, text } from "./view.test-support.tsx";

it("keeps failed inventory reads separate from confirmed empty providers", () => {
  const onRefresh = vi.fn();
  const container = mount(props({ cards: [], error: "Inventory unavailable", onRefresh }));
  expect(text(container)).toContain("Inventory unavailable");
  expect(text(container)).not.toContain(t("modelProviders.emptyTitle"));
  expect(text(container)).not.toContain(t("modelProviders.emptySubtitle"));
  getByRole(container, "button", { name: t("common.retry"), exact: true }).click();
  expect(onRefresh).toHaveBeenCalledOnce();
  mount(props({ cards: [], providerUsageFailed: true }), container);
  expect(text(container)).toContain(t("modelProviders.emptyTitle"));
  expect(text(container)).toContain(t("usage.providerUsage.unavailable"));
});
