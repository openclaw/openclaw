/**
 * Fork regression tests for NO_REPLY / silent token handling.
 *
 * These tests verify our fork-specific fixes that prevent NO_REPLY from leaking
 * to users through various delivery paths:
 * 1. Outbound delivery (announce/cron) — stripSilentToken in normalizeReplyPayloadsForDelivery
 * 2. Partial NO_REPLY suppression — isSilentReplyPrefixText catches stream fragments
 * 3. A2A / sessions_send — silent tokens filtered from reply values
 * 4. Signoff emission — watchdog disarms when parseReplyDirectives strips silent tokens
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  stripSilentToken,
} from "../../auto-reply/tokens.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";

// ─── 1. Outbound delivery path (fork fix: 538db52f4) ───────────────────────
// normalizeReplyPayloadsForDelivery must strip trailing NO_REPLY from
// mixed-content messages so the token never leaks via announce/cron delivery.

describe("normalizeReplyPayloadsForDelivery — NO_REPLY stripping (fork fix: 538db52f4)", () => {
  it("strips trailing NO_REPLY from mixed-content payload", () => {
    const payloads = [{ text: "Here is the update.\n\nNO_REPLY" }];
    const result = normalizeReplyPayloadsForDelivery(payloads as any);
    expect(result.length).toBe(1);
    expect(result[0].text).toBe("Here is the update.");
    expect(result[0].text).not.toContain("NO_REPLY");
  });

  it("drops pure NO_REPLY payloads entirely (no media)", () => {
    const payloads = [{ text: "NO_REPLY" }];
    const result = normalizeReplyPayloadsForDelivery(payloads as any);
    // Pure silent payload with no media should be dropped
    expect(result.length).toBe(0);
  });

  it("preserves payload with NO_REPLY but has media", () => {
    const payloads = [{ text: "NO_REPLY", mediaUrl: "https://example.com/image.png" }];
    const result = normalizeReplyPayloadsForDelivery(payloads as any);
    // Media present — payload kept, text stripped
    expect(result.length).toBe(1);
  });

  it("does not strip NO_REPLY embedded in substantive text", () => {
    const payloads = [{ text: "The agent responded with NO_REPLY which means silence." }];
    const result = normalizeReplyPayloadsForDelivery(payloads as any);
    expect(result.length).toBe(1);
    // stripSilentToken only strips trailing occurrences, not embedded ones
    expect(result[0].text).toContain("NO_REPLY");
  });

  it("strips NO_REPLY preceded by bold markdown", () => {
    const payloads = [{ text: "Done. **NO_REPLY" }];
    const result = normalizeReplyPayloadsForDelivery(payloads as any);
    expect(result.length).toBe(1);
    expect(result[0].text).not.toContain("NO_REPLY");
    expect(result[0].text).toBe("Done.");
  });

  it("does not drop HEARTBEAT_OK (different suppression path)", () => {
    const payloads = [{ text: "HEARTBEAT_OK" }];
    const result = normalizeReplyPayloadsForDelivery(payloads as any);
    // HEARTBEAT_OK is handled by heartbeat-specific logic, not the generic delivery path
    expect(result.length).toBe(1);
  });
});

// ─── 2. Partial NO_REPLY suppression (fork fixes: 11b7d90e6, eab8a2ba6, 891fde7b1) ──
// When the model streams NO_REPLY as multiple tokens (e.g. 'NO' then '_REPLY'),
// partial fragments must be suppressed to prevent leaking to nodes/chat clients.

describe("isSilentReplyPrefixText — partial fragment suppression", () => {
  it("catches all NO_REPLY streaming fragments", () => {
    // These are the actual fragments that can appear during streaming
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_R")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REP")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPL")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true); // full match is also prefix
  });

  it("does not suppress natural language that starts with 'No'", () => {
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("No problem")).toBe(false);
    expect(isSilentReplyPrefixText("Not sure")).toBe(false);
    expect(isSilentReplyPrefixText("Nothing")).toBe(false);
  });

  it("handles HEARTBEAT_OK fragments with underscore guard", () => {
    // Without underscore, generic tokens could match unrelated words
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(false);
    // After underscore, we're confident it's the token
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyPrefixText("HEARTBEAT_O", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects single character fragments (too ambiguous)", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("H")).toBe(false);
  });

  it("handles leading whitespace", () => {
    expect(isSilentReplyPrefixText("  NO_")).toBe(true);
    expect(isSilentReplyPrefixText("\n NO_RE")).toBe(true);
  });
});

// ─── 3. A2A silent token filtering (fork fixes: 28788b060, c5a4f04d1) ──────
// sessions_send and A2A ping-pong must not treat NO_REPLY/HEARTBEAT_OK as
// valid replies, or infinite loops result.

describe("A2A silent token filtering", () => {
  it("isSilentReplyText catches NO_REPLY in A2A reply context", () => {
    // This is the check used in sessions-send-tool.ts to filter reply values
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
  });

  it("does not filter substantive replies containing the token", () => {
    expect(isSilentReplyText("I understand. NO_REPLY")).toBe(false);
    expect(isSilentReplyText("NO_REPLY acknowledged")).toBe(false);
  });

  it("stripSilentToken extracts content from mixed replies", () => {
    // In case a reply has real content + trailing NO_REPLY
    expect(stripSilentToken("Task complete.\nNO_REPLY")).toBe("Task complete.");
    expect(stripSilentToken("Done NO_REPLY")).toBe("Done");
  });
});

// ─── 4. Signoff emission integrity (fork fix: 101a93b09) ───────────────────
// When parseReplyDirectives strips a silent token, a signoff event must be
// emitted so the reply-chain-enforcer (watchdog) disarms properly.
// This is tested at integration level in reply-chain-enforcer.test.ts,
// but we verify the token detection logic here.

describe("signoff detection for silent tokens (fork fix: 101a93b09)", () => {
  it("full NO_REPLY is detected as silent (triggers signoff)", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("full HEARTBEAT_OK is detected as silent (triggers signoff)", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
  });

  it("whitespace-wrapped tokens still detected", () => {
    expect(isSilentReplyText("\n  NO_REPLY  \n")).toBe(true);
    expect(isSilentReplyText("  HEARTBEAT_OK\n", "HEARTBEAT_OK")).toBe(true);
  });
});

// ─── 5. Full pipeline: mixed content through delivery normalization ─────────
// Verifies the complete path from agent output → outbound delivery doesn't leak.

describe("end-to-end: NO_REPLY never reaches outbound", () => {
  const cases = [
    { input: "NO_REPLY", expectDropped: true, desc: "pure silent" },
    { input: "  NO_REPLY  ", expectDropped: true, desc: "whitespace-wrapped silent" },
    { input: "HEARTBEAT_OK", expectDropped: false, desc: "heartbeat token (different path)" },
    { input: "Done.\n\nNO_REPLY", expectDropped: false, desc: "mixed content (stripped)" },
    { input: "Hello world", expectDropped: false, desc: "normal reply" },
  ];

  for (const { input, expectDropped, desc } of cases) {
    it(`${desc}: "${input.slice(0, 30)}"`, () => {
      const result = normalizeReplyPayloadsForDelivery([{ text: input }] as any);
      if (expectDropped) {
        expect(result.length).toBe(0);
      } else {
        expect(result.length).toBe(1);
        expect(result[0].text).not.toContain("NO_REPLY");
      }
    });
  }
});
