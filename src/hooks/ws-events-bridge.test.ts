import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEventSummary,
  createWsEventsNdjsonLineHandler,
  extractResourceType,
  transformCloudEvent,
} from "./ws-events-bridge.js";

describe("extractResourceType", () => {
  it("extracts resource type from standard event type", () => {
    expect(extractResourceType("google.workspace.chat.message.v1.created")).toBe("chat.message");
  });

  it("handles drive event types", () => {
    expect(extractResourceType("google.workspace.drive.file.v1.updated")).toBe("drive.file");
  });

  it("handles calendar event types", () => {
    expect(extractResourceType("google.workspace.calendar.event.v1.created")).toBe(
      "calendar.event",
    );
  });

  it("returns original if no prefix match", () => {
    expect(extractResourceType("custom.event.type")).toBe("custom.event.type");
  });

  it("handles empty string", () => {
    expect(extractResourceType("")).toBe("");
  });
});

describe("buildEventSummary", () => {
  it("builds human-readable summary", () => {
    expect(
      buildEventSummary(
        "google.workspace.chat.message.v1.created",
        "//chat.googleapis.com/spaces/X",
      ),
    ).toBe("chat.message created from //chat.googleapis.com/spaces/X");
  });
});

describe("transformCloudEvent", () => {
  it("transforms a full CloudEvent", () => {
    const event = {
      type: "google.workspace.chat.message.v1.created",
      source: "//chat.googleapis.com/spaces/X",
      time: "2026-02-13T10:00:00Z",
      data: { message: { text: "hello" } },
    };
    const result = transformCloudEvent(event);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      type: "google.workspace.chat.message.v1.created",
      source: "//chat.googleapis.com/spaces/X",
      time: "2026-02-13T10:00:00Z",
      resourceType: "chat.message",
      summary: "chat.message created from //chat.googleapis.com/spaces/X",
      data: { message: { text: "hello" } },
    });
  });

  it("handles missing fields gracefully", () => {
    const result = transformCloudEvent({});
    expect(result.events[0]).toEqual({
      type: "",
      source: "",
      time: "",
      resourceType: "",
      summary: "  from ",
      data: {},
    });
  });

  it("handles non-object data", () => {
    const result = transformCloudEvent({ type: "test", data: "string-data" });
    expect(result.events[0]?.data).toEqual({});
  });

  it("handles null data", () => {
    const result = transformCloudEvent({ type: "test", data: null });
    expect(result.events[0]?.data).toEqual({});
  });
});

describe("createWsEventsNdjsonLineHandler", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses JSON line, transforms, and POSTs", () => {
    const handler = createWsEventsNdjsonLineHandler({
      hookUrl: "http://localhost/hooks/workspace-events",
      hookToken: "tok",
    });

    const line = JSON.stringify({
      type: "google.workspace.chat.message.v1.created",
      source: "//chat.googleapis.com/spaces/X",
      time: "2026-02-13T10:00:00Z",
      data: { message: { text: "hello" } },
    });

    handler(line);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe("http://localhost/hooks/workspace-events");
    const body = JSON.parse((opts as RequestInit).body as string) as Record<string, unknown>;
    const events = body.events as Array<Record<string, unknown>>;
    expect(events[0]?.type).toBe("google.workspace.chat.message.v1.created");
    expect(events[0]?.resourceType).toBe("chat.message");
  });

  it("ignores empty lines", () => {
    const handler = createWsEventsNdjsonLineHandler({
      hookUrl: "http://localhost/hooks/workspace-events",
      hookToken: "tok",
    });

    handler("");
    handler("   ");

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("ignores non-JSON lines", () => {
    const handler = createWsEventsNdjsonLineHandler({
      hookUrl: "http://localhost/hooks/workspace-events",
      hookToken: "tok",
    });

    handler("not json at all");

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
