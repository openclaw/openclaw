import { describe, expect, it } from "vitest";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";

describe("GATEWAY_EVENTS", () => {
  it("advertises Talk event streams in hello features", () => {
    expect(GATEWAY_EVENTS).toEqual(expect.arrayContaining(["talk.event"]));
    expect(GATEWAY_EVENTS).not.toEqual(
      expect.arrayContaining(["talk.realtime.relay", "talk.transcription.relay"]),
    );
  });
});

describe("listGatewayMethods", () => {
  it("advertises plugin surface refresh for capability rotation", () => {
    expect(listGatewayMethods()).toEqual(expect.arrayContaining(["node.pluginSurface.refresh"]));
  });

  it("advertises task control RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "tasks.list",
        "tasks.get",
        "tasks.cancel",
        "tasks.flows.list",
        "tasks.flows.get",
        "tasks.flows.cancel",
      ]),
    );
  });

  it("advertises assistant safe metadata RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "assistant.status",
        "assistant.decisions.list",
        "assistant.continueCandidates",
      ]),
    );
  });

  it("advertises the versioned Talk session RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "talk.client.create",
        "talk.client.toolCall",
        "talk.session.create",
        "talk.session.join",
        "talk.session.appendAudio",
        "talk.session.startTurn",
        "talk.session.endTurn",
        "talk.session.cancelTurn",
        "talk.session.cancelOutput",
        "talk.session.submitToolResult",
        "talk.session.close",
      ]),
    );
  });
});
