/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { renderMcp } from "./mcp.tsx";

type McpViewProps = Parameters<typeof renderMcp>[0];

function createProps(overrides: Partial<McpViewProps> = {}): McpViewProps {
  return {
    configObject: {
      mcp: {
        servers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            auth: "oauth",
            toolFilter: { include: ["search"] },
          },
          local: {
            command: "node",
            enabled: false,
            supportsParallelToolCalls: true,
          },
        },
      },
    },
    pluginsHref: "/settings/plugins",
    editor: <div class="test-editor" />,
    ...overrides,
  };
}

function mountMcp(props: McpViewProps) {
  const { gateway } = createApplicationGateway();
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const context = {
    gateway,
    runtimeConfig,
    agentSelection: { subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => renderMcp(props), { wrapper: provider.wrapper });
  onTestFinished(() => {
    view.unmount();
    runtimeConfig.dispose();
  });
  return view.container;
}

function buttonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} button`);
  }
  return button;
}

describe("renderMcp", () => {
  it("renders summary counts, operator commands, and the managed servers card", () => {
    const container = mountMcp(createProps());

    const summary = container.querySelector(".mcp-page__summary");
    expect(summary?.textContent).toContain("Servers");
    expect(
      [...(summary?.querySelectorAll(".settings-row") ?? [])].map((row) => [
        row.querySelector(".settings-row__title")?.textContent,
        row.querySelector(".settings-row__control")?.textContent,
      ]),
    ).toEqual([
      ["Servers", "2"],
      ["Enabled", "1"],
      ["OAuth", "1"],
      ["Filtered", "1"],
    ]);
    expect(container.textContent).toContain("openclaw mcp doctor --probe");

    const card = container.querySelector("openclaw-mcp-servers-card");
    expect(card).not.toBeNull();
    expect(card?.pluginsHref).toBe("/settings/plugins");
  });

  it("keeps the summary free of save actions and preserves the embedded editor", () => {
    const container = mountMcp(createProps());

    expect(buttonByText.bind(null, container, "Save")).toThrow();
    expect(buttonByText.bind(null, container, "Save & Publish")).toThrow();
    expect(container.querySelector(".test-editor")).not.toBeNull();
  });
});
