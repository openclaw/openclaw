import { describe, expect, it, vi } from "vitest";
import { listChannelSetupPlugins } from "../channels/plugins/setup-registry.js";
import { resolveChannelSetupEntries } from "../commands/channel-setup/discovery.js";
import { isStaticallyChannelConfigured } from "../config/channel-configured-shared.js";
import {
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

// mock-isolation: Setup guidance uses synthetic plugins without loading installed channel runtimes.
vi.mock("../channels/plugins/setup-registry.js", () => ({ listChannelSetupPlugins: vi.fn() }));
vi.mock("../commands/channel-setup/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/channel-setup/discovery.js")>()),
  resolveChannelSetupEntries: vi.fn(),
}));
vi.mock("../config/channel-configured-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/channel-configured-shared.js")>()),
  isStaticallyChannelConfigured: vi.fn(),
}));

function expectOperation(input: string, operation: ReturnType<typeof parseSystemAgentOperation>) {
  expect(parseSystemAgentOperation(input)).toEqual(operation);
}
function expectLines(lines: string[], expected: string[]) {
  for (const text of expected) {
    expect(lines.join("\n")).toContain(text);
  }
}

describe("system agent setup-flow operations", () => {
  it("parses channel listing and connect requests", () => {
    expectOperation("channels", { kind: "channel-list" });
    expectOperation("list channels", { kind: "channel-list" });
    expectOperation("connect telegram", { kind: "channel-setup", channel: "telegram" });
    expectOperation("connect to WhatsApp", { kind: "channel-setup", channel: "whatsapp" });
    expectOperation("link discord channel", { kind: "channel-setup", channel: "discord" });
    // Starting the wizard is not a write; the wizard collects explicit answers.
    expect(isPersistentSystemAgentOperation({ kind: "channel-setup", channel: "telegram" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "channel-list" })).toBe(false);
  });

  it("parses hosted skills, web-search, and Gateway setup requests", () => {
    for (const input of ["configure skills", "setup skills", "set up skills"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "skills-setup" });
    }
    for (const input of [
      "configure search",
      "configure web search",
      "setup search",
      "web search provider setup",
    ]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "search-setup" });
    }
    expect(parseSystemAgentOperation("open search wizard")).toEqual({
      kind: "open-setup",
      target: "search",
    });
    for (const input of ["configure gateway", "set up gateway", "gateway settings"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "gateway-config-setup" });
    }
    expect(parseSystemAgentOperation("open gateway wizard")).toEqual({
      kind: "open-setup",
      target: "gateway",
    });
    expect(isPersistentSystemAgentOperation({ kind: "skills-setup" })).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "search-setup" })).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "gateway-config-setup" })).toBe(false);
    expect(parseSystemAgentOperation("configure search with brave").kind).toBe("none");
  });

  it("parses the exact memory-import grammar", () => {
    for (const input of ["import memory", "import memories", "memory import"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "memory-import" });
    }
    expect(isPersistentSystemAgentOperation({ kind: "memory-import" })).toBe(false);
    expect(parseSystemAgentOperation("import memory from codex").kind).toBe("none");
  });

  it("parses anchored setup switches and channel info", () => {
    for (const input of [
      "open setup wizard",
      "setup wizard",
      "menu setup",
      "use the setup wizard",
      "use the wizard",
    ]) {
      expectOperation(input, { kind: "open-setup", target: "guided" });
    }
    for (const input of ["open classic wizard", "open classic setup wizard", "classic setup"]) {
      expectOperation(input, { kind: "open-setup", target: "classic" });
    }
    expectOperation("open channel wizard", { kind: "open-setup", target: "channels" });
    expectOperation("open channel wizard for Slack", {
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
    expectOperation("channel info Slack", { kind: "channel-info", channel: "slack" });
    expectOperation("about Telegram channel", { kind: "channel-info", channel: "telegram" });
    expect(parseSystemAgentOperation("please open the setup wizard soon").kind).toBe("none");
    expect(parseSystemAgentOperation("channel info slack please").kind).toBe("none");
  });

  it("prints one-shot setup pointers", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    for (const operation of [
      { kind: "open-setup", target: "guided" } as const,
      { kind: "open-setup", target: "classic" } as const,
      { kind: "open-setup", target: "channels", channel: "slack" } as const,
      { kind: "open-setup", target: "search" } as const,
      { kind: "open-setup", target: "gateway" } as const,
    ]) {
      const result = await executeSystemAgentOperation(operation, runtime);
      expect(result.applied).toBe(false);
    }

    expectLines(lines, [
      "openclaw onboard`",
      "openclaw onboard --classic",
      "openclaw channels add --channel slack",
      "openclaw configure --section web",
      "openclaw configure --section gateway",
      "on the machine running OpenClaw",
    ]);
  });

  it("prints one-shot pointers for hosted skills, search, and Gateway setup", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "skills-setup" }, runtime);
    await executeSystemAgentOperation({ kind: "search-setup" }, runtime);
    await executeSystemAgentOperation({ kind: "gateway-config-setup" }, runtime);

    expectLines(lines, [
      "openclaw configure --section skills",
      "openclaw configure --section web",
      "openclaw configure --section gateway",
    ]);
  });

  it("points one-shot memory import at interactive owners", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "memory-import" }, runtime);

    expect(lines.join("\n")).toContain("Memory page in the Control UI");
    expect(lines.join("\n")).toContain("openclaw onboard");
  });

  it("directs one-shot model setup to protected Models controls without a write", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation({ kind: "model-setup" }, runtime);

    expect(result.applied).toBe(false);
    expectLines(lines, [
      "Settings → Models → Connect provider",
      "selected System or agent scope",
      "replacing credentials for a provider already in use",
    ]);
    expect(lines.join("\n")).not.toContain("openclaw onboard");
  });

  it("prints discovered channel metadata and sorted unknown-channel choices", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const entries: ReturnType<typeof resolveChannelSetupEntries>["entries"] = (
      [
        ["telegram", "Telegram", "bot"],
        ["slack", "Slack", "app"],
      ] as const
    ).map(([id, label, kind]) => ({
      id,
      meta: {
        id,
        label,
        selectionLabel: label,
        blurb: `${label} ${kind} messaging.`,
        docsPath: `/channels/${id}`,
      },
    }));
    vi.mocked(listChannelSetupPlugins).mockReturnValue([
      {
        id: "slack",
        meta: entries[1]!.meta,
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      },
    ]);
    vi.mocked(resolveChannelSetupEntries).mockReturnValue({
      entries,
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    vi.mocked(isStaticallyChannelConfigured).mockImplementation(
      (_cfg, channel) => channel === "slack",
    );

    await executeSystemAgentOperation({ kind: "channel-info", channel: "slack" }, runtime);
    expectLines(lines, [
      "Slack (slack)",
      "Slack app messaging.",
      "Configured: yes",
      "Installed: yes",
      "https://docs.openclaw.ai/channels/slack",
      "open channel wizard for slack",
    ]);

    lines.length = 0;
    await executeSystemAgentOperation({ kind: "channel-info", channel: "matrix" }, runtime);
    expect(lines.join("\n")).toContain("Known channels: slack, telegram");
  });
});
