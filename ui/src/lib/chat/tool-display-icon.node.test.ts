// @vitest-environment node

import { expect, it } from "vitest";
import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import { iconData } from "../../components/icon-data.ts";

it("can render every shared tool icon, including the fallback", () => {
  for (const [name, spec] of Object.entries({
    fallback: SHARED_TOOL_DISPLAY_JSON.fallback,
    ...SHARED_TOOL_DISPLAY_JSON.tools,
  })) {
    expect(Object.hasOwn(iconData, spec.icon), `${name}: ${spec.icon}`).toBe(true);
  }
});
