import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import handler from "./handler.js";
import { createHookEvent } from "../../hooks.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import type { ClawdbotConfig } from "../../../config/config.js";

describe("soul-evil hook", () => {
  it("skips subagent sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-soul-"));
    await fs.writeFile(path.join(tempDir, "SOUL_EVIL.md"), "chaotic", "utf-8");

    const cfg: ClawdbotConfig = {
      hooks: {
        internal: {
          entries: {
            "soul-evil": { enabled: true, chance: 1 },
          },
        },
      },
    };
    const context: AgentBootstrapHookContext = {
      workspaceDir: tempDir,
      bootstrapFiles: [
        {
          name: "SOUL.md",
          path: path.join(tempDir, "SOUL.md"),
          content: "friendly",
          missing: false,
        },
      ],
      cfg,
      sessionKey: "agent:main:subagent:abc",
    };

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);

    expect(context.bootstrapFiles[0]?.content).toBe("friendly");
  });
});
