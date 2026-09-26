import { describe, expect, it } from "vitest";
import { buildBackupArchivePath } from "./backup-shared.js";

describe("Windows namespace backup archive paths", () => {
  const agent =
    "root/payload/windows/C/Users/Eric/.openclaw/agents/main/agent/openclaw-agent.sqlite";

  it.each([
    [String.raw`C:\Users\Eric\.openclaw\agents\main\agent\openclaw-agent.sqlite`, agent],
    [String.raw`\\?\C:\Users\Eric\.openclaw\agents\main\agent\openclaw-agent.sqlite`, agent],
    [String.raw`\\.\C:\Users\Eric\.openclaw\agents\main\agent\openclaw-agent.sqlite`, agent],
    ["//?/C:/Users/Eric/.openclaw/agents/main/agent/openclaw-agent.sqlite", agent],
    ["//./C:/Users/Eric/.openclaw/agents/main/agent/openclaw-agent.sqlite", agent],
    [
      String.raw`\\?\UNC\server\share\openclaw-agent.sqlite`,
      "root/payload/posix/server/share/openclaw-agent.sqlite",
    ],
    [
      String.raw`\\server\share\openclaw-agent.sqlite`,
      "root/payload/posix/server/share/openclaw-agent.sqlite",
    ],
    [
      "/home/eric/.openclaw/openclaw-agent.sqlite",
      "root/payload/posix/home/eric/.openclaw/openclaw-agent.sqlite",
    ],
    [
      String.raw`\\?\Volume{00000000-0000-0000-0000-000000000001}\agent.sqlite`,
      "root/payload/posix/?/Volume{00000000-0000-0000-0000-000000000001}/agent.sqlite",
    ],
  ])("encodes %s as one portable payload path", (sourcePath, expected) => {
    expect(buildBackupArchivePath("root", sourcePath)).toBe(expected);
  });
});
