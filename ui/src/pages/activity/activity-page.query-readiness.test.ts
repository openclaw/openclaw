/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  activitySettings,
  activityHello,
  activityResponse,
  activityRoster,
  createActivityPage,
} from "./activity-page.test-support.ts";

it("keeps the current query loading when superseded requests settle", async () => {
  const { gateway: source, current } = createGatewayStoreTestStore({
    settings: activitySettings(),
  });
  const sessions = createTestSessionCapability(source);
  try {
    const context = {
      ...createContext(source, sessions),
      basePath: "",
      resourceBasePath: "",
      replace: vi.fn(),
    };
    source.start();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? activityRoster([]) : activityResponse(method, params),
    );
    current().testOptions.onHello?.(activityHello());
    const page = createActivityPage(context, { pathname: "/activity", search: "", hash: "" });
    await waitForSolid(() =>
      expect(page.container.querySelector(".activity-feed__empty")).not.toBeNull(),
    );
    const reads = Array.from({ length: 3 }, () => createDeferred<SessionsListResult>());
    let requestIndex = 0;
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" && asOptionalRecord(params)?.source === "activity"
        ? reads[requestIndex++]!.promise
        : activityResponse(method, params),
    );
    for (const query of ["alpha", "beta", "alpha"]) {
      page.setRouteLocation({ pathname: "/activity", search: `?q=${query}`, hash: "" });
      flush();
    }
    expect(requestIndex).toBe(3);
    for (const read of reads.slice(0, 2)) {
      read.resolve(activityRoster([]));
      await waitForSolid(() =>
        expect(
          page.container.querySelector('.activity-feed__loading[aria-busy="true"]'),
        ).not.toBeNull(),
      );
      expect(page.container.querySelector("[data-activity-session]")).toBeNull();
    }
    reads[2]!.resolve(activityRoster([]));
    await waitForSolid(() =>
      expect(page.container.querySelector(".activity-feed__loading")).toBeNull(),
    );
  } finally {
    cleanupSolid();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    source.stop();
    await vi.dynamicImportSettled();
    setAvatarGatewayOrigin(null);
    localStorage.clear();
    sessionStorage.clear();
  }
});
