/* @vitest-environment jsdom */

import "../test-helpers/app-sidebar-suite.ts";
import "../test-helpers/app-sidebar-cases/categorized-child-sessions.ts";
import "../test-helpers/app-sidebar-cases/child-session-errors.ts";
import "../test-helpers/app-sidebar-cases/child-session-archive.ts";
import "../test-helpers/app-sidebar-cases/child-sessions-cap.ts";
import "../test-helpers/app-sidebar-cases/child-sessions.ts";
import "../test-helpers/app-sidebar-cases/narration.ts";
import "../test-helpers/app-sidebar-cases/outbox-badges.ts";
import "../test-helpers/app-sidebar-cases/session-indicators.ts";
import "../test-helpers/app-sidebar-cases/session-delegated-activity.ts";
import "../test-helpers/app-sidebar-cases/sessions.ts";
import "../test-helpers/app-sidebar-cases/session-ownership.ts";
import "../test-helpers/app-sidebar-cases/session-ownership-filtering.ts";
import "../test-helpers/app-sidebar-cases/session-list-sections.ts";
import "../test-helpers/app-sidebar-cases/sidebar-zone.ts";
import "../test-helpers/app-sidebar-cases/plugin-session-list.ts";
import { expect, it } from "vitest";
import { viewer, withOwnerSidebar } from "../test-helpers/agent-sidebar.test-support.ts";

it("keeps a single-user title plain and includes sessions without owner metadata", async () => {
  await withOwnerSidebar(
    ["mine", "other", "agent-owned"].map((id) => ({
      key: `agent:main:${id}`,
      agentId: "main",
      kind: "direct",
    })),
    [viewer],
    "query",
    async ({ sidebar, settle }) => {
      await settle();
      expect(sidebar.querySelector("#sidebar-session-owner-title")).toBeNull();
      expect(sidebar.querySelector(".sidebar-session-toolbar")?.textContent).toContain("Sessions");
      expect(sidebar.querySelectorAll(".sidebar-recent-session[data-session-key]")).toHaveLength(3);
      const query = sidebar.sessionData.sessionListQuery("main");
      expect(query.ownerId).toBeUndefined();
      expect(query.involvingMe).toBeUndefined();
    },
  );
});
