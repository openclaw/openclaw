import { describe, expect, it } from "vitest";
import type { AgentItemEventData } from "../infra/agent-activity-events.js";
import { ToolActivityPresentation } from "./tool-activity-presentation.js";

function complete(owner: ToolActivityPresentation, id: string, hidden = false) {
  const call = {
    toolCallId: id,
    activity: {
      itemId: `tool:${id}`,
      title: id,
      phase: "end",
      kind: "tool",
      status: "completed",
      ...(hidden ? { hideFromChannelProgress: true } : {}),
    } satisfies AgentItemEventData,
  };
  owner.complete(call);
  return call;
}
const drain = (owner: ToolActivityPresentation) => [...owner.drain()].map((item) => item.itemId);

describe("live activity nesting", () => {
  it("links late parents and publishes each hidden wrapper once", () => {
    const owner = new ToolActivityPresentation();
    owner.start("leaf", "inner");
    complete(owner, "leaf");
    expect(drain(owner)).toEqual([]);
    owner.start("inner", "outer");
    owner.start("outer");
    complete(owner, "inner");
    complete(owner, "outer");
    expect(drain(owner)).toEqual(["tool:inner", "tool:outer"]);
    expect(drain(owner)).toEqual([]);
  });

  it("keeps cycle members separate while retaining their noncycle children", () => {
    const owner = new ToolActivityPresentation();
    owner.start("a", "b");
    owner.start("b", "a");
    owner.start("leaf", "a");
    complete(owner, "leaf");
    complete(owner, "a");
    complete(owner, "b");
    expect(drain(owner)).toEqual(["tool:a"]);
  });

  it("disconnects reused identities before they can hide their ancestors", () => {
    const owner = new ToolActivityPresentation();
    owner.start("root");
    owner.start("wrapper", "root");
    owner.start("leaf", "wrapper");
    complete(owner, "leaf");
    owner.start("wrapper", "root");
    complete(owner, "wrapper");
    complete(owner, "root");
    expect(drain(owner)).toEqual([]);
  });

  it("propagates visible grandchildren through a routine wrapper", () => {
    const owner = new ToolActivityPresentation();
    owner.start("root");
    owner.start("routine", "root");
    owner.start("leaf", "routine");
    complete(owner, "root");
    complete(owner, "routine", true);
    expect(drain(owner)).toEqual([]);
    complete(owner, "leaf");
    expect(drain(owner)).toEqual(["tool:root"]);
  });
});
