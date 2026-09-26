/* @vitest-environment jsdom */
import { beforeEach, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import "../test-helpers/app-sidebar-cases/catalog-compat.ts";
import "../test-helpers/app-sidebar-cases/catalog-live-events.ts";
import "../test-helpers/app-sidebar-cases/catalog-project-activity.ts";
import "../test-helpers/app-sidebar-cases/catalog-row-lifecycle.ts";
import "../test-helpers/app-sidebar-cases/catalog-live.ts";
import "../test-helpers/app-sidebar-cases/catalog-pagination-visibility.ts";
import "../test-helpers/app-sidebar-cases/catalog-reconnect.ts";
import "../test-helpers/app-sidebar-cases/catalog-live-errors.ts";
import "../test-helpers/app-sidebar-cases/catalog-live-state.ts";
import "../test-helpers/app-sidebar-cases/catalog-ownership.ts";
import "../test-helpers/app-sidebar-cases/catalog-terminal-owner.ts";
import "../test-helpers/app-sidebar-cases/catalog-pages.ts";

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
});
