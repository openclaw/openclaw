import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveUserPath } from "../utils.js";
import { getAgentScopedMediaLocalRoots } from "./local-roots.js";

describe("getAgentScopedMediaLocalRoots", () => {
  it("merges iMessage attachment roots into the agent-scoped allowlist", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
        },
      },
    };

    expect(getAgentScopedMediaLocalRoots(cfg)).toContain("/Users/*/Library/Messages/Attachments");
  });

  it("adds the resolved agent workspace without dropping attachment roots", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          attachmentRoots: ["/tmp/imessage-attachments"],
        },
      },
      agents: {
        list: [
          {
            id: "clawdy",
            workspace: "~/agent-workspace",
          },
        ],
      },
    };

    const roots = getAgentScopedMediaLocalRoots(cfg, "clawdy");

    expect(roots).toContain("/tmp/imessage-attachments");
    expect(roots).toContain(path.resolve(resolveStateDir(), "workspace"));
    expect(roots).toContain(path.resolve(resolveUserPath("~/agent-workspace")));
  });
});
