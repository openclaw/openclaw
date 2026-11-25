// Hook frontmatter tests cover hook metadata parsing from hook files.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parseHookFrontmatter, resolveHookManifestMetadata } from "./frontmatter.js";

function requireString(value: string | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe("resolveHookManifestMetadata", () => {
  it("returns undefined when metadata is missing", () => {
    const frontmatter = { name: "no-metadata" };
    const result = resolveHookManifestMetadata(frontmatter);
    expect(result).toBeUndefined();
  });

  it("handles install specs", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        openclaw: {
          events: ["command"],
          install: [
            { id: "bundled", kind: "bundled", label: "Bundled with OpenClaw" },
            { id: "npm", kind: "npm", package: "@openclaw/hook" },
          ],
        },
      }),
    };

    const result = resolveHookManifestMetadata(frontmatter);
    expect(result?.install).toHaveLength(2);
    expect(expectDefined(result?.install?.[0], "result?.install?.[0] test invariant").kind).toBe(
      "bundled",
    );
    expect(expectDefined(result?.install?.[1], "result?.install?.[1] test invariant").kind).toBe(
      "npm",
    );
    expect(expectDefined(result?.install?.[1], "result?.install?.[1] test invariant").package).toBe(
      "@openclaw/hook",
    );
  });

  it("handles os restrictions", () => {
    const frontmatter = {
      metadata: JSON.stringify({
        openclaw: {
          events: ["command"],
          os: ["darwin", "linux"],
        },
      }),
    };

    const result = resolveHookManifestMetadata(frontmatter);
    expect(result?.os).toEqual(["darwin", "linux"]);
  });

  it("parses real session-memory HOOK.md format", () => {
    // This is the actual format used in the bundled hooks
    const content = `---
name: session-memory
description: "Save session context to memory when a session is reset"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset", "session:auto-reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook
`;

    const frontmatter = parseHookFrontmatter(content);
    expect(frontmatter.name).toBe("session-memory");
    expect(requireString(frontmatter.metadata, "session-memory metadata")).toContain(
      '"command:reset"',
    );

    const openclaw = expectDefined(resolveHookManifestMetadata(frontmatter), "hook metadata");
    expect(openclaw.emoji).toBe("💾");
    expect(openclaw.events).toEqual(["command:new", "command:reset", "session:auto-reset"]);
    expect(openclaw.requires?.config).toEqual(["workspace.dir"]);
    expect(expectDefined(openclaw.install?.[0], "openclaw.install?.[0] test invariant").kind).toBe(
      "bundled",
    );
  });
});
