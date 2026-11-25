/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { Mcp } from "./mcp.tsx";

function mountMcp() {
  const { gateway } = createApplicationGateway();
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const context = {
    gateway,
    runtimeConfig,
    agentSelection: { subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <Mcp editor={<div class="test-editor" />} />, {
    wrapper: provider.wrapper,
  });
  onTestFinished(() => {
    view.unmount();
    runtimeConfig.dispose();
  });
  return view.container;
}

describe("Mcp", () => {
  it("leads with the server list and keeps reference commands on demand", () => {
    const container = mountMcp();

    expect(container.querySelector("openclaw-mcp-servers-card")).not.toBeNull();
    expect(container.querySelector(".test-editor")).not.toBeNull();
    const commands = container.querySelector<HTMLDetailsElement>("details.mcp-page__commands");
    expect(commands?.open).toBe(false);
    expect(commands?.textContent).toContain("openclaw mcp doctor --probe");
    expect(commands?.querySelectorAll(".chat-copy-btn")).toHaveLength(3);
  });

  it("has no summary counts and no save actions", () => {
    const container = mountMcp();

    expect(container.querySelector(".mcp-page__summary")).toBeNull();
    expect(container.textContent).not.toContain("Filtered");
    const labels = [...container.querySelectorAll("button")].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).not.toContain("Save");
  });
});
