/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  clearPaneSessionHandoffs,
  consumePaneSessionHandoff,
  preparePaneSessionHandoff,
  retireSessionPaneHandoffs,
} from "./chat-pane-shared.ts";

it.each(["gateway", "principal"] as const)(
  "retires only the deleted session's captured %s handoffs",
  (change) => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const principal = { recoveryScope: "original" };
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

      retireSessionPaneHandoffs(context, [{ key, retireBeforeRevision: 200 }], owner, "original");

      expect(consumePaneSessionHandoff(context, "original", key)).toBeNull();
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
