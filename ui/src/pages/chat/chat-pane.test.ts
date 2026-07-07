/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createPaneSessionSelectOptions } from "./chat-pane.ts";

function createSessionRow(key: string, label: string): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    label,
    updatedAt: 1,
  };
}

describe("pane session select options", () => {
  it("labels rows with linear position and current-session state", () => {
    const options = createPaneSessionSelectOptions({
      sessionKey: "agent:main:main",
      sessions: [
        createSessionRow("agent:main:main", "Main chat"),
        createSessionRow("agent:main:work", "Main work"),
      ],
    });

    expect(options).toEqual([
      {
        ariaLabel: "Main chat, current session, session 1 of 2 in the loaded list",
        key: "agent:main:main",
        label: "Main chat",
        position: 1,
        selected: true,
        visibleLabel: "1. Main chat",
      },
      {
        ariaLabel: "Main work, session 2 of 2 in the loaded list",
        key: "agent:main:work",
        label: "Main work",
        position: 2,
        selected: false,
        visibleLabel: "2. Main work",
      },
    ]);
  });

  it("keeps the selected session addressable when the loaded list omits it", () => {
    const options = createPaneSessionSelectOptions({
      sessionKey: "agent:main:missing",
      sessions: [createSessionRow("agent:main:work", "Main work")],
    });

    expect(options[0]).toMatchObject({
      ariaLabel: "agent:main:missing, current session, session 1 of 2 in the loaded list",
      key: "agent:main:missing",
      position: 1,
      selected: true,
      visibleLabel: "1. agent:main:missing",
    });
    expect(options[1]?.position).toBe(2);
  });
});
