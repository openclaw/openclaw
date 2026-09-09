// Routing binding tests cover the shared diagnostic/account binding helpers.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildChannelAccountBindings,
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
} from "./bindings.js";

describe("route binding account helpers", () => {
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} } },
    bindings: [{ agentId: "main", match: { channel: "telegram" } }],
  };

  it("includes an omitted accountId as the default account", () => {
    expect(listBoundAccountIds(cfg, "telegram")).toEqual(["default"]);
    expect(resolveDefaultAgentBoundAccountId(cfg, "telegram")).toBe("default");
    expect(buildChannelAccountBindings(cfg)).toEqual(
      new Map([["telegram", new Map([["main", ["default"]]])]]),
    );
  });
});
