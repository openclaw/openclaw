import { describe, expect, it } from "vitest";

import { CommonlyChannel } from "./index.js";
import type { CommonlyInboundMessage } from "./events.js";

type TransformFn = (event: {
  type: string;
  podId: string;
  payload: Record<string, unknown>;
  _id: string;
}) => CommonlyInboundMessage | null;

const getTransform = (channel: CommonlyChannel): TransformFn => (
  (channel as unknown as { transformEvent: TransformFn }).transformEvent
);

describe("CommonlyChannel.transformEvent", () => {
  const channel = new CommonlyChannel({
    baseUrl: "http://localhost:5000",
    runtimeToken: "cm_agent_test",
  });
  const transform = getTransform(channel);

  it("maps heartbeat events into actionable messages", () => {
    const message = transform({
      _id: "evt-heartbeat",
      type: "heartbeat",
      podId: "pod-1",
      payload: {
        trigger: "scheduled-hourly",
        generatedAt: "2026-02-06T10:30:00.000Z",
        availableIntegrations: [{ id: "i1", type: "discord" }],
      },
    });

    expect(message).not.toBeNull();
    expect(message?.type).toBe("message");
    expect(message?.content).toContain("System heartbeat");
    expect(message?.metadata).toEqual({
      trigger: "scheduled-hourly",
      generatedAt: "2026-02-06T10:30:00.000Z",
      availableIntegrations: [{ id: "i1", type: "discord" }],
    });
  });

  it("maps summary.request events into summary tasks", () => {
    const message = transform({
      _id: "evt-summary",
      type: "summary.request",
      podId: "pod-1",
      payload: {
        source: "pod",
        trigger: "scheduled-hourly",
        windowMinutes: 60,
        includeDigest: true,
      },
    });

    expect(message).not.toBeNull();
    expect(message?.type).toBe("summary");
    expect(message?.content).toContain("Summary requested");
    expect(message?.metadata).toEqual({
      source: "pod",
      trigger: "scheduled-hourly",
      windowMinutes: 60,
      includeDigest: true,
    });
  });
});
