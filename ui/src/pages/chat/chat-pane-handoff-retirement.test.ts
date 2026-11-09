/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { paneSessionHandoffs, retireSessionPaneHandoffs } from "./chat-pane-handoff-lifecycle.ts";
import {
  clearPaneSessionHandoffs,
  consumePaneSessionHandoff,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";

it.each(["gateway", "principal"] as const)(
  "retires only the deleted session's current %s handoffs",
  (change) => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const principal = { recoveryScope: "original", recoveryScopeReady: true };
    const owner = principal as GatewayBrowserClient;
    const fixture = createApplicationGateway();
    const { gateway } = fixture;
    const context = { gateway } as ApplicationContext;
    const key = "agent:main:deleted";
    try {
      fixture.publish({ ...gateway.snapshot, client: owner });
      preparePaneSessionHandoff(context, "original", key, { draft: "retire", attachments: [] });
      if (change === "principal") {
        principal.recoveryScope = "other";
      } else {
        fixture.publish({ ...gateway.snapshot, client: { ...principal } as GatewayBrowserClient });
      }
      preparePaneSessionHandoff(context, "other", key, { draft: "keep", attachments: [] });
      const otherOwner = gateway.snapshot.client;
      principal.recoveryScope = "original";
      fixture.publish({ ...gateway.snapshot, client: owner });
      // A principal change retires presentation identity irreversibly. Stage
      // the current owner again so deletion, not the switch, retires this entry.
      preparePaneSessionHandoff(context, "original", key, { draft: "retire", attachments: [] });
      retireSessionPaneHandoffs(context, [{ key, retireBeforeRevision: 200 }]);

      expect(paneSessionHandoffs.get(context)?.get("original")).toEqual([]);
      expect(paneSessionHandoffs.get(context)?.get("other")).toHaveLength(1);
      expect(consumePaneSessionHandoff(context, "original", key)).toBeNull();
      expect(consumePaneSessionHandoff(context, "other", key)).toBeNull();
      if (change === "principal") {
        principal.recoveryScope = "other";
      }
      fixture.publish({ ...gateway.snapshot, client: otherOwner });
      if (change === "principal") {
        expect(consumePaneSessionHandoff(context, "other", key)).toBeNull();
        preparePaneSessionHandoff(context, "other", key, { draft: "keep", attachments: [] });
      }
      expect(consumePaneSessionHandoff(context, "other", key)).toEqual({
        draft: "keep",
        attachments: [],
      });
      expect(consumePaneSessionHandoff(context, "other", key)).toBeNull();
    } finally {
      clearPaneSessionHandoffs(context, "original");
      clearPaneSessionHandoffs(context, "other");
      vi.useRealTimers();
    }
  },
);
