// Locks the per-channel approvalText audit (RFC 0002 step 1).
//
// The regression this guards against: a channel whose outbound path renders the
// canonical markdown subset is left at the plaintext default, so the forwarder
// downgrade strips formatting the channel shows today. That is exactly how
// Feishu and Teams slipped through the first pass — both render markdown
// (markdownDialect) but were not declared. This test pins the full audit so a
// new channel, or a channel that gains markdown rendering, cannot silently take
// the wrong default.
//
// Source-scanning rather than runtime: declarations live in three shapes
// (inline in channel.ts, an exported const, a factory), and importing every
// channel plugin would pull all hot-path channel modules into one test. Reading
// the source keeps the guard cheap and declaration-shape agnostic.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = path.join(repoRoot, "extensions");

/**
 * Expected approval text mode per channel, with the render mechanism that
 * justifies it. "markdown" means the outbound path renders the canonical
 * subset, so approval text must stay markdown. "plaintext" means no render
 * mechanism exists, so the safe default is correct.
 */
const EXPECTED: Record<string, { mode: "markdown" | "plaintext"; why: string }> = {
  // Render markdown via outbound presentation (markdownDialect: "markdown").
  feishu: { mode: "markdown", why: "markdownDialect card renderer" },
  matrix: { mode: "markdown", why: "markdownDialect formatted_body" },
  mattermost: { mode: "markdown", why: "markdownDialect, server renders markdown" },
  msteams: { mode: "markdown", why: "markdownDialect Adaptive Card TextBlock" },
  telegram: { mode: "markdown", why: "markdownDialect parse-mode send" },
  // Render markdown via a channel-specific mechanism (send-path conversion,
  // native payloads, or a markdown transport message type).
  discord: { mode: "markdown", why: "native component payloads render markdown" },
  signal: { mode: "markdown", why: "send-path markdownToSignalText" },
  slack: { mode: "markdown", why: "native mrkdwn/Block Kit payloads" },
  whatsapp: { mode: "markdown", why: "send-path markdownToWhatsApp" },
  qqbot: { mode: "markdown", why: "msg_type 2 markdown on enabled accounts" },
  // No markdown render mechanism: plaintext default is correct.
  googlechat: { mode: "plaintext", why: "no markdown render mechanism" },
  "nextcloud-talk": { mode: "plaintext", why: "no markdownDialect, no send-path render" },
  "synology-chat": { mode: "plaintext", why: "no markdown render mechanism" },
  zalo: { mode: "plaintext", why: "no markdown render mechanism" },
  // Intentionally plaintext for step 1; step 2 (#85954) flips it to markdown.
  imessage: { mode: "plaintext", why: "step-1 default; typed runs land in step 2" },
};

function readChannelSource(channel: string): string {
  const srcDir = path.join(extensionsDir, channel, "src");
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        parts.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(srcDir);
  return parts.join("\n");
}

function declaresApprovalCapability(source: string): boolean {
  return /approvalCapability\b/.test(source) || /createChannelApprovalAuth\b/.test(source);
}

function declaresMarkdownApprovalText(source: string): boolean {
  return /approvalText:\s*"markdown"/.test(source);
}

function rendersMarkdown(source: string): boolean {
  return /markdownDialect:\s*"markdown"/.test(source);
}

const channelDirs = fs
  .readdirSync(extensionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(extensionsDir, name, "src")))
  .filter((name) => declaresApprovalCapability(readChannelSource(name)))
  .sort();

describe("approvalText per-channel audit (RFC 0002 step 1)", () => {
  it("covers every channel that declares an approval capability", () => {
    // A new approval-capable channel must land in EXPECTED with an explicit
    // audit decision rather than silently defaulting to plaintext.
    const unaccounted = channelDirs.filter((c) => !(c in EXPECTED));
    expect(unaccounted, `undocumented approval channels: ${unaccounted.join(", ")}`).toEqual([]);
  });

  it.each(channelDirs)("%s declares the audited approvalText mode", (channel) => {
    const source = readChannelSource(channel);
    const expected = EXPECTED[channel];
    expect(expected, `channel ${channel} missing from EXPECTED`).toBeDefined();
    if (expected.mode === "markdown") {
      expect(
        declaresMarkdownApprovalText(source),
        `${channel} renders markdown (${expected.why}) but does not declare approvalText: "markdown"`,
      ).toBe(true);
    } else {
      expect(
        declaresMarkdownApprovalText(source),
        `${channel} is expected plaintext (${expected.why}) but declares approvalText: "markdown"`,
      ).toBe(false);
    }
  });

  it("declares approvalText: \"markdown\" for every channel whose outbound renders markdown via markdownDialect", () => {
    // The invariant that would have caught Feishu and Teams automatically:
    // a markdownDialect renderer must not downgrade its approval text.
    const violations = channelDirs.filter((channel) => {
      const source = readChannelSource(channel);
      return rendersMarkdown(source) && !declaresMarkdownApprovalText(source);
    });
    expect(
      violations,
      `channels rendering markdown but defaulting approvals to plaintext: ${violations.join(", ")}`,
    ).toEqual([]);
  });
});
