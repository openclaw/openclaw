import { describe, expect, it } from "vitest";
import {
  buildTelegramExecApprovalButtons,
  extractApprovalIdFromText,
  injectTelegramApprovalButtons,
} from "./approval-buttons.js";

describe("telegram approval buttons", () => {
  it("extracts approval id from canonical approve command", () => {
    expect(extractApprovalIdFromText("Run: /approve 117ba06d allow-once")).toBe("117ba06d");
  });

  it("extracts approval id when command includes bot mention", () => {
    expect(extractApprovalIdFromText("Run: /approve@openclaw_bot ab12cd34 allow-once")).toBe(
      "ab12cd34",
    );
  });

  it("extracts approval id when allow-once uses unicode dash", () => {
    expect(extractApprovalIdFromText("Run: /approve ab12cd34 allow‑once")).toBe("ab12cd34");
  });

  it("extracts approval id when allow once is separated by whitespace", () => {
    expect(extractApprovalIdFromText("Run: /approve ab12cd34 allow once")).toBe("ab12cd34");
  });

  it("prefers reply-with instruction over /approve text inside command blocks", () => {
    expect(
      extractApprovalIdFromText(
        [
          "Command:",
          "```sh",
          "echo '/approve wrong123 allow-once'",
          "```",
          "Reply with: /approve right456 allow-once|allow-always|deny",
        ].join("\n"),
      ),
    ).toBe("right456");
  });

  it("returns undefined for placeholder docs text", () => {
    expect(
      extractApprovalIdFromText("Reply with: /approve <id> allow-once|allow-always|deny"),
    ).toBe(undefined);
  });

  it("builds allow-once/allow-always/deny buttons", () => {
    expect(buildTelegramExecApprovalButtons("fbd8daf7")).toEqual([
      [
        { text: "Allow Once", callback_data: "/approve fbd8daf7 allow-once" },
        { text: "Allow Always", callback_data: "/approve fbd8daf7 allow-always" },
      ],
      [{ text: "Deny", callback_data: "/approve fbd8daf7 deny" }],
    ]);
  });

  it("skips buttons when callback_data exceeds Telegram limit", () => {
    expect(buildTelegramExecApprovalButtons(`a${"b".repeat(60)}`)).toBeUndefined();
  });

  it("injects approval buttons into telegram channelData when missing", () => {
    const payload = {
      text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
    };
    const next = injectTelegramApprovalButtons(payload);
    expect(next).toEqual({
      text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
      channelData: {
        telegram: {
          buttons: [
            [
              { text: "Allow Once", callback_data: "/approve 117ba06d allow-once" },
              { text: "Allow Always", callback_data: "/approve 117ba06d allow-always" },
            ],
            [{ text: "Deny", callback_data: "/approve 117ba06d deny" }],
          ],
        },
      },
    });
  });

  it("prefers structured exec approval metadata for callback ids", () => {
    const payload = {
      text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      channelData: {
        execApproval: {
          approvalId: "117ba06d-1111-2222-3333-444444444444",
          approvalSlug: "117ba06d",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    };

    const next = injectTelegramApprovalButtons(payload);

    expect(next).toEqual({
      text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
      channelData: {
        execApproval: {
          approvalId: "117ba06d-1111-2222-3333-444444444444",
          approvalSlug: "117ba06d",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        telegram: {
          buttons: [
            [
              {
                text: "Allow Once",
                callback_data: "/approve 117ba06d-1111-2222-3333-444444444444 allow-once",
              },
              {
                text: "Allow Always",
                callback_data: "/approve 117ba06d-1111-2222-3333-444444444444 allow-always",
              },
            ],
            [{ text: "Deny", callback_data: "/approve 117ba06d-1111-2222-3333-444444444444 deny" }],
          ],
        },
      },
    });
  });

  it("does not override existing telegram buttons", () => {
    const payload = {
      text: "Run: /approve 117ba06d allow-once",
      channelData: {
        telegram: {
          buttons: [[{ text: "Existing", callback_data: "keep" }]],
        },
      },
    };
    expect(injectTelegramApprovalButtons(payload)).toBe(payload);
  });
});
