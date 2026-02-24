import { describe, expect, it } from "vitest";
import { extractActivityMetaFromMessage } from "./extract.js";
import { renderActivityLine } from "./render.js";

describe("activity rendering", () => {
  it("hides IDs in normal mode", () => {
    const rendered = renderActivityLine(
      {
        kind: "tool",
        summary: "Write AGENTS.md",
        runId: "run-123",
        toolCallId: "call-456",
        status: "ok",
      },
      { mode: "normal", time: "10:00:00" },
    );

    expect(rendered).toContain("Write AGENTS.md");
    expect(rendered).not.toContain("run-123");
    expect(rendered).not.toContain("call-456");
  });

  it("includes IDs in full mode", () => {
    const rendered = renderActivityLine(
      {
        kind: "tool",
        summary: "Write AGENTS.md",
        runId: "run-123",
        toolCallId: "call-456",
        status: "ok",
      },
      { mode: "full" },
    );

    expect(rendered).toContain("runId=run-123");
    expect(rendered).toContain("toolCallId=call-456");
  });

  it("truncates previews by mode", () => {
    const preview = "x".repeat(200);
    const normal = renderActivityLine(
      {
        kind: "reply",
        summary: "reply body",
        preview,
      },
      { mode: "normal" },
    );
    const full = renderActivityLine(
      {
        kind: "reply",
        summary: "reply body",
        preview,
      },
      { mode: "full" },
    );

    expect(normal).toContain('preview="');
    expect(normal).toContain("…");
    expect(full).toContain(`preview="${preview}"`);
  });
});

describe("activity heuristics", () => {
  it("extracts tool lifecycle events", () => {
    const activity = extractActivityMetaFromMessage(
      "embedded run tool end: runId=run-1 tool=write toolCallId=call-1",
    );

    expect(activity).toMatchObject({
      kind: "tool",
      runId: "run-1",
      toolCallId: "call-1",
    });
  });

  it("extracts route resolution events", () => {
    const activity = extractActivityMetaFromMessage(
      "[routing] resolveAgentRoute: channel=whatsapp accountId=default peer=direct:+123 guildId=none teamId=none bindings=0",
    );

    expect(activity).toMatchObject({
      kind: "route",
      channel: "whatsapp",
      status: "ok",
    });
  });
});
