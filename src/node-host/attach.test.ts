import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NodeAttachLaunch, prepareNodeAttach } from "./attach.js";

let home = "";
let launch: NodeAttachLaunch | undefined;
afterEach(async () => {
  await launch?.forwarder.close();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
  home = "";
  launch = undefined;
});

describe("prepareNodeAttach (PR5 conduit + PR7 hydration integration)", () => {
  it("grants, hydrates the gateway conversation, starts the forwarder, returns a --resume launch", async () => {
    home = mkdtempSync(join(tmpdir(), "nodeattach-"));
    const request = vi.fn(async (method: string) => {
      if (method === "node.attachGrant") {
        return { sessionKey: "agent:main", token: "tok-1", expiresAtMs: 9e12 };
      }
      if (method === "node.attachHydrate") {
        return {
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello back" },
          ],
        };
      }
      return {};
    });
    launch = await prepareNodeAttach({
      client: { request },
      cwd: "/work/proj",
      nowMs: 1e6,
      homeDir: home,
    });

    expect(request).toHaveBeenCalledWith("node.attachGrant", {});
    expect(request).toHaveBeenCalledWith("node.attachHydrate", { grantToken: "tok-1" });
    // a conversation existed → hydrate a transcript and --resume it (pick-up-anywhere)
    expect(launch.launchArgs).toEqual(["--resume", launch.cliSessionId]);
    expect(launch.transcriptPath && existsSync(launch.transcriptPath)).toBe(true);
    // the harness points at the LOCAL forwarder; token rides the env placeholder, not argv/config
    expect((launch.mcpConfig.mcpServers.openclaw as { url: string }).url).toBe(
      launch.forwarder.url,
    );
    expect(
      (launch.mcpConfig.mcpServers.openclaw as { headers: { Authorization: string } }).headers
        .Authorization,
    ).toContain("${OPENCLAW_MCP_TOKEN}");
    expect(launch.env.OPENCLAW_MCP_TOKEN).toBe("tok-1");
  });

  it("falls back to a fresh --session-id when there is no conversation to hydrate", async () => {
    home = mkdtempSync(join(tmpdir(), "nodeattach-"));
    const request = vi.fn(async (method: string) =>
      method === "node.attachGrant"
        ? { sessionKey: "agent:main", token: "t", expiresAtMs: 9e12 }
        : { messages: [] },
    );
    launch = await prepareNodeAttach({
      client: { request },
      cwd: "/work/proj",
      nowMs: 1e6,
      homeDir: home,
    });
    expect(launch.launchArgs).toEqual(["--session-id", launch.cliSessionId]);
    expect(launch.transcriptPath).toBeUndefined();
  });
});
