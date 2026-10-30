// Verifies the session capability summary keeps session limits distinct from product limits.
import { describe, expect, it, vi } from "vitest";
import type { EffectiveToolInventoryResult } from "../tools-effective-inventory.types.js";
import {
  formatSessionCapabilities,
  resolveSessionCapabilities,
} from "./session-status-capabilities.js";

describe("session capability summary", () => {
  it("groups missing tools by the policy reason and keeps final presence authoritative", async () => {
    const inventory = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            { id: "read", label: "Read", description: "", rawDescription: "", source: "core" },
            { id: "exec", label: "Exec", description: "", rawDescription: "", source: "core" },
          ],
        },
      ],
      notices: [
        { id: "browser-denied-by-policy", severity: "info", message: "Browser is denied." },
      ],
      toolAccess: {
        checked: "live-session",
        profiles: [],
        tools: [
          // A host-owned tool can survive filtering; presence in the final set wins.
          {
            id: "exec",
            status: "excluded",
            reasons: [{ kind: "deny", label: "Denied by tools.deny" }],
          },
          {
            id: "browser",
            status: "excluded",
            reasons: [{ kind: "deny", label: "Denied by tools.deny" }],
          },
          {
            id: "canvas",
            status: "excluded",
            reasons: [{ kind: "deny", label: "Denied by tools.deny" }],
          },
          {
            id: "tts",
            status: "unavailable",
            reasons: [{ kind: "runtime", label: "Not included in the session preview" }],
          },
        ],
      },
    } satisfies EffectiveToolInventoryResult;

    const summary = await resolveSessionCapabilities({
      callGateway: vi.fn().mockResolvedValue(inventory),
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(summary).toEqual({
      checked: "live-session",
      available: ["exec", "read"],
      unavailable: [
        { reason: "Denied by tools.deny", tools: ["browser", "canvas"] },
        { reason: "Not included in the session preview", tools: ["tts"] },
      ],
      notices: ["Browser is denied."],
    });
    expect(formatSessionCapabilities(summary)).toBe(
      [
        "Capabilities (this session only; other sessions, agents, or config can differ):",
        "Available tools: exec, read",
        "Not available in this session:",
        "- Denied by tools.deny: browser, canvas",
        "- Not included in the session preview: tts",
        "Notices:",
        "- Browser is denied.",
      ].join("\n"),
    );
  });
});
