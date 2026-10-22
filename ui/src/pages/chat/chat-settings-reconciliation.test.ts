/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each(["model", "thinking"] as const)(
  "reconciles a %s change through the session owner without a second roster read",
  async (setting) => {
    const initial: GatewaySessionRow = {
      key: "agent:main:settings-reconciliation",
      agentId: "main",
      sessionId: "settings-session",
      kind: "direct",
      updatedAt: 1,
      model: "example/previous",
      thinkingLevel: "high",
    };
    const confirmed: GatewaySessionRow = {
      ...initial,
      updatedAt: 2,
      ...(setting === "model" ? { model: "example/next" } : { thinkingLevel: "low" }),
    };
    const rows = [initial];
    const list = vi.fn<GatewayRequestHandler>(() => sessionsResult([...rows], 1));
    const patch = vi.fn<GatewayRequestHandler>(() => {
      rows[0] = confirmed;
      return { ok: true, key: initial.key, path: "", entry: confirmed };
    });
    const { sessions, mount } = createMountedPanes(rows, "main", undefined, {
      "sessions.list": list,
      "sessions.patch": patch,
    });
    await sessions.refresh({ agentId: "main", force: true });
    const pane = mount(initial.key);
    await refreshPane(pane);
    await sessions.refresh({ agentId: "main", limit: 7, force: true });
    const previousReads = list.mock.calls.length;

    const changed =
      setting === "model"
        ? await switchChatModel(pane.state, "example/next")
        : await switchChatSetting(pane.state, { kind: "thinkingLevel", value: "low" });

    expect(changed).toBe(true);
    expect(patch).toHaveBeenCalledOnce();
    expect(selectedChatSessionRow(pane.state)).toMatchObject(confirmed);
    expect(list.mock.calls.length - previousReads).toBe(1);
    expect(list.mock.calls.at(-1)?.[1]).toMatchObject({ agentId: "main", limit: 7 });
  },
);
