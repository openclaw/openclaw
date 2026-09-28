/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { retireSessionPaneHandoffs } from "./chat-pane-handoff-lifecycle.ts";
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
      retireSessionPaneHandoffs(context, [{ key, retireBeforeRevision: 200 }]);

      expect(consumePaneSessionHandoff(context, "original", key)).toBeNull();
      expect(consumePaneSessionHandoff(context, "other", key)).toBeNull();
      if (change === "principal") {
        principal.recoveryScope = "other";
      }
      fixture.publish({ ...gateway.snapshot, client: otherOwner });
      expect(consumePaneSessionHandoff(context, "other", key)).toEqual({
        draft: "keep",
        attachments: [],
      });
    } finally {
      clearPaneSessionHandoffs(context, "original");
      clearPaneSessionHandoffs(context, "other");
      vi.useRealTimers();
    }
  },
);
