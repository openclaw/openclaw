import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type MyWorldManifest = {
  id?: string;
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      transport?: string;
      toolFilter?: { include?: string[] };
    }
  >;
};

function readMyWorldManifest(): MyWorldManifest {
  return JSON.parse(
    readFileSync(new URL("../../extensions/myworld/openclaw.plugin.json", import.meta.url), "utf8"),
  ) as MyWorldManifest;
}

describe("myworld bundled MCP plugin", () => {
  it("pins the shared practice-world server to the reviewed PyPI release", () => {
    const manifest = readMyWorldManifest();
    const server = manifest.mcpServers?.myworld;

    expect(manifest.id).toBe("myworld");
    expect(server).toMatchObject({
      transport: "stdio",
      command: "uvx",
      args: ["myworld==0.2.1", "world", "invoice-review"],
    });
  });

  it("exposes the invoice-review world controls and focused Gmail, Slack and Drive tools", () => {
    const include = readMyWorldManifest().mcpServers?.myworld?.toolFilter?.include ?? [];

    expect(include).toEqual(
      expect.arrayContaining([
        "world_task",
        "world_grade",
        "world_snapshot",
        "gmail__search_emails",
        "gmail__read_email",
        "slack__slack_get_channel_history",
        "drive__read_sheet_values",
        "drive__modify_sheet_values",
      ]),
    );
    expect(include).not.toContain("gmail__delete_email");
  });
});
