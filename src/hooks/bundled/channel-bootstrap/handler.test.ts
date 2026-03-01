import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import handler, { extractChannelId } from "./handler.js";

// ---------------------------------------------------------------------------
// Unit tests: extractChannelId
// ---------------------------------------------------------------------------

describe("extractChannelId", () => {
  it("extracts Discord channel id", () => {
    expect(extractChannelId("agent:main:discord:channel:1473810409952641138")).toBe(
      "1473810409952641138",
    );
  });

  it("extracts Discord channel id from thread session key (ignores thread segment)", () => {
    expect(
      extractChannelId("agent:main:discord:channel:1473810409952641138:thread:987654321"),
    ).toBe("1473810409952641138");
  });

  it("extracts Telegram group id (negative number)", () => {
    expect(extractChannelId("agent:main:telegram:group:-1001234567890")).toBe("-1001234567890");
  });

  it("extracts Slack channel id (uppercase, as stored in config)", () => {
    expect(extractChannelId("agent:main:slack:channel:C0123ABCDEF")).toBe("C0123ABCDEF");
  });

  it("extracts Slack channel id (lowercase, as normalised by session-key.ts at runtime)", () => {
    expect(extractChannelId("agent:main:slack:channel:c0123abcdef")).toBe("c0123abcdef");
  });

  it("extracts WhatsApp group id", () => {
    expect(extractChannelId("agent:main:whatsapp:group:120363403215116621@g.us")).toBe(
      "120363403215116621@g.us",
    );
  });

  it("returns null for DM / main session key", () => {
    expect(extractChannelId("agent:main:main")).toBeNull();
  });

  it("returns null for subagent session key without channel", () => {
    expect(extractChannelId("agent:main:subagent:abc123")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: full handler flow
// ---------------------------------------------------------------------------

function makeContext(params: {
  workspaceDir: string;
  sessionKey: string;
  agentsMdContent?: string;
  agentsMdMissing?: boolean;
}): AgentBootstrapHookContext {
  const bootstrapFiles: AgentBootstrapHookContext["bootstrapFiles"] = [];
  if (params.agentsMdContent !== undefined || params.agentsMdMissing) {
    bootstrapFiles.push({
      name: "AGENTS.md",
      path: path.join(params.workspaceDir, "AGENTS.md"),
      content: params.agentsMdContent,
      missing: params.agentsMdMissing ?? false,
    });
  }
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles,
    cfg: {},
    sessionKey: params.sessionKey,
  };
}

describe("channel-bootstrap handler", () => {
  it("appends channel context to existing AGENTS.md when channel file is present", async () => {
    const dir = await makeTempWorkspace("openclaw-channel-bootstrap-");
    const channelsDir = path.join(dir, "channels");
    await fs.mkdir(channelsDir, { recursive: true });
    await fs.writeFile(path.join(channelsDir, "123456.md"), "# Dev Build\nShip it.", "utf-8");

    const context = makeContext({
      workspaceDir: dir,
      sessionKey: "agent:main:discord:channel:123456",
      agentsMdContent: "# Global AGENTS\n\nGlobal stuff.",
    });

    const event = createHookEvent("agent", "bootstrap", context.sessionKey!, context);
    await handler(event);

    const agents = context.bootstrapFiles.find((f) => f.name === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.content).toContain("Global AGENTS");
    expect(agents!.content).toContain("Channel-Specific Context");
    expect(agents!.content).toContain("Ship it.");
    expect(context.bootstrapFiles.filter((f) => f.name === "AGENTS.md")).toHaveLength(1);
  });

  it("does not mutate the original cached entry (clone on write)", async () => {
    const dir = await makeTempWorkspace("openclaw-channel-bootstrap-clone-");
    const channelsDir = path.join(dir, "channels");
    await fs.mkdir(channelsDir, { recursive: true });
    await fs.writeFile(path.join(channelsDir, "123456.md"), "Channel only.", "utf-8");

    const originalEntry = {
      name: "AGENTS.md" as const,
      path: path.join(dir, "AGENTS.md"),
      content: "Global.",
      missing: false,
    };
    const context = makeContext({
      workspaceDir: dir,
      sessionKey: "agent:main:discord:channel:123456",
      agentsMdContent: "Global.",
    });
    // Replace with known reference so we can check identity
    context.bootstrapFiles[0] = originalEntry;

    const event = createHookEvent("agent", "bootstrap", context.sessionKey!, context);
    await handler(event);

    // The slot in the array should be a new object, not the original reference
    expect(context.bootstrapFiles[0]).not.toBe(originalEntry);
    // Original entry content must be untouched
    expect(originalEntry.content).toBe("Global.");
    // New entry should have the appended content
    expect(context.bootstrapFiles[0].content).toContain("Channel only.");
  });

  it("injects new non-missing AGENTS.md entry when only a missing placeholder exists", async () => {
    const dir = await makeTempWorkspace("openclaw-channel-bootstrap-missing-");
    const channelsDir = path.join(dir, "channels");
    await fs.mkdir(channelsDir, { recursive: true });
    await fs.writeFile(path.join(channelsDir, "999.md"), "Channel only.", "utf-8");

    const context = makeContext({
      workspaceDir: dir,
      sessionKey: "agent:main:discord:channel:999",
      agentsMdMissing: true,
    });

    const event = createHookEvent("agent", "bootstrap", context.sessionKey!, context);
    await handler(event);

    const nonMissingAgents = context.bootstrapFiles.filter(
      (f) => f.name === "AGENTS.md" && !f.missing,
    );
    expect(nonMissingAgents).toHaveLength(1);
    expect(nonMissingAgents[0].content).toContain("Channel only.");
    expect(nonMissingAgents[0].path).toContain("AGENTS.md");
    expect(nonMissingAgents[0].path).not.toContain("channels");
  });

  it("silently skips and does not modify bootstrap files when no channel file exists", async () => {
    const dir = await makeTempWorkspace("openclaw-channel-bootstrap-skip-");

    const context = makeContext({
      workspaceDir: dir,
      sessionKey: "agent:main:discord:channel:9999999",
      agentsMdContent: "Global.",
    });

    const event = createHookEvent("agent", "bootstrap", context.sessionKey!, context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].content).toBe("Global.");
  });

  it("skips DM / main sessions with no channel id", async () => {
    const dir = await makeTempWorkspace("openclaw-channel-bootstrap-dm-");

    const context = makeContext({
      workspaceDir: dir,
      sessionKey: "agent:main:main",
      agentsMdContent: "Global.",
    });

    const event = createHookEvent("agent", "bootstrap", context.sessionKey!, context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].content).toBe("Global.");
  });

  it("skips non-bootstrap events without modifying context", async () => {
    const dir = await makeTempWorkspace("openclaw-channel-bootstrap-skip-event-");

    const context = makeContext({
      workspaceDir: dir,
      sessionKey: "agent:main:discord:channel:123",
      agentsMdContent: "Global.",
    });

    const event = createHookEvent("command", "new", context.sessionKey!, context as never);
    await handler(event as never);

    expect(context.bootstrapFiles[0].content).toBe("Global.");
  });
});
