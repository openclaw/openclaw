import { describe, expect, it } from "vitest";
import type {
  ComputerUseCapabilityDescriptor,
  ComputerUseV2ActionName,
} from "../../plugins/computer-use-contract.js";
import { buildComputerToolDescription } from "./computer-tool-guidance.js";

function descriptor(
  actions: ComputerUseV2ActionName[],
  overrides: Partial<ComputerUseCapabilityDescriptor> = {},
): ComputerUseCapabilityDescriptor {
  return {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions,
    targets: ["screen", "window", "element", "browser"],
    deliveryModes: ["background", "foreground"],
    observations: ["image", "accessibility", "browser"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
    ...overrides,
  };
}

describe("computer tool guidance", () => {
  it("stays provider-neutral and free of host setup instructions", () => {
    const description = buildComputerToolDescription(
      descriptor([
        "screenshot",
        "left_click",
        "list_windows",
        "get_accessibility_tree",
        "get_window_state",
        "set_value",
      ]),
    );

    expect(description).toContain("Observe first with `get_window_state`");
    expect(description).toContain("capture the desktop and return frameId");
    expect(description).toContain("do not accept window or browser targets");
    expect(description).toContain("observationId for window input");
    expect(description).toContain("`list_windows` to obtain windowRef");
    expect(description).toContain("`get_accessibility_tree` for unfiltered desktop discovery");
    expect(description).toContain("`query`, `depth`, and `maxElements` filters");
    expect(description).toContain('`effect:"confirmed"` > `unverifiable` > `suspected_noop`');
    expect(description).toContain("never blind-retry a mutation");
    expect(description).toContain("without another observation call");
    expect(description).toContain("For window input");
    expect(description).toContain("untrusted input");
    expect(description).not.toMatch(
      /cua|peekaboo|\b(?:cli|mcp|daemon|socket|install(?:ation|ing)?)\b|verify_state|start_session|end_session|element_token|snapshot_id|window_id|delivery_mode/iu,
    );
    expect(description.length).toBeLessThan(2_400);
  });

  it("includes only the selected node's advertised capability families", () => {
    const desktopOnly = buildComputerToolDescription(
      descriptor(["screenshot", "left_click"], {
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
      }),
    );
    expect(desktopOnly).toContain("desktop coordinates from the latest screenshot");
    expect(desktopOnly).toContain("stale frameId");
    expect(desktopOnly).toContain("unchanged screen returns metadata only and reuses its frameId");
    expect(desktopOnly).not.toMatch(
      /get_window_state|accessibility|elementRef|window pixels|deliveryMode:"background"|background_unavailable|without another observation call/,
    );

    const windowBackground = buildComputerToolDescription(
      descriptor(["left_click", "list_windows", "get_window_state", "set_value"], {
        targets: ["window", "element"],
        deliveryModes: ["background"],
      }),
    );
    expect(windowBackground).toContain(
      "elementRef from the latest observation > window coordinates from the latest observation",
    );
    expect(windowBackground).toContain('deliveryMode:"background"');
    expect(windowBackground).toContain("background_occluded");
    expect(windowBackground).not.toMatch(/desktop coordinates|foreground|frameId/);

    const discoveryOnly = buildComputerToolDescription(descriptor(["get_accessibility_tree"]));
    expect(discoveryOnly).not.toMatch(/get_window_state|list_windows|unfiltered/);

    const imageOnly = buildComputerToolDescription(
      descriptor(["list_windows", "get_accessibility_tree", "get_window_state"], {
        observations: ["image"],
      }),
    );
    expect(imageOnly).toContain("advertised image data");
    expect(imageOnly).not.toMatch(/window subtree|`query`|`depth`|`maxElements`/);
  });

  it("distinguishes key taps from advertised held-key support", () => {
    const taps = buildComputerToolDescription(descriptor(["screenshot", "key"]));
    expect(taps).toContain("key taps only");
    expect(taps).not.toContain("`hold_key`");
    const holds = buildComputerToolDescription(descriptor(["screenshot", "key", "hold_key"]));
    expect(holds).toContain("`hold_key`");
    expect(holds).not.toContain("key taps only");
  });
});
