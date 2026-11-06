import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusPluginHealthSnapshot } from "../../status/status-plugin-health.js";
import { buildStatusPluginsReply } from "./commands-status.js";
import type { CommandContext } from "./commands-types.js";

const { collectInstalledPluginHealthSnapshot } = vi.hoisted(() => ({
  collectInstalledPluginHealthSnapshot: vi.fn<() => Promise<StatusPluginHealthSnapshot>>(),
}));

vi.mock("../../status/status-plugin-health.runtime.js", () => ({
  collectInstalledPluginHealthSnapshot,
}));
vi.mock("../../status/status-text.js", () => ({
  buildStatusReplyParts: vi.fn(),
  buildStatusText: vi.fn(),
}));

const command: CommandContext = {
  surface: "discord",
  channel: "discord",
  ownerList: [],
  senderIsOwner: true,
  isAuthorizedSender: true,
  rawBodyNormalized: "/status plugins",
  commandBodyNormalized: "/status plugins",
};

async function replyWithDiagnostics(diagnostics: StatusPluginHealthSnapshot["diagnostics"]) {
  collectInstalledPluginHealthSnapshot.mockResolvedValue({
    plugins: [],
    diagnostics,
    contextEngineQuarantines: [],
  });
  return buildStatusPluginsReply({ cfg: { commands: { plugins: true } }, command });
}

beforeEach(() => {
  collectInstalledPluginHealthSnapshot.mockReset();
});

describe("/status plugins diagnostics", () => {
  it("shows informational diagnostics without marking plugin health unhealthy", async () => {
    const reply = await replyWithDiagnostics([
      {
        level: "info",
        pluginId: "crabbox",
        message: "Explicitly selected plugin overrides bundled",
      },
    ]);

    expect(reply?.text).toContain("Information: 1");
    expect(reply?.text).toContain("- INFO crabbox: Explicitly selected plugin overrides bundled");
    expect(reply?.text?.split("\n")[0]).toBe("🔌 Plugins: OK");
    expect(reply?.text).not.toContain("Diagnostics:");
  });

  it("reserves actionable diagnostic rows when informational diagnostics precede them", async () => {
    const reply = await replyWithDiagnostics([
      ...Array.from({ length: 9 }, (_, index) => ({
        level: "info" as const,
        message: `Expected override ${index}`,
      })),
      { level: "warn", pluginId: "ambiguous", message: "Resolve duplicate plugin ID" },
      { level: "error", pluginId: "broken", message: "Plugin could not load" },
    ]);

    expect(reply?.text).toContain(
      "Diagnostics: 1 errors · 1 warnings\n- WARN ambiguous: Resolve duplicate plugin ID\n- ERROR broken: Plugin could not load",
    );
    expect(reply?.text).toContain("Information: 9");
    expect(reply?.text?.split("\n").filter((line) => line.startsWith("- INFO "))).toHaveLength(8);
    expect(reply?.text).toContain("- INFO Expected override 7");
    expect(reply?.text).not.toContain("Expected override 8");
    expect(reply?.text?.split("\n")[0]).toBe("⚠️ Plugins: 1 diagnostic error");
  });
});
