import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { hydrateSendAttachmentParams } from "./message-action-params.js";

describe("hydrateSendAttachmentParams", () => {
  it("normalizes inline buffers for send actions", async () => {
    const args: Record<string, unknown> = {
      buffer: "data:image/png;base64,QUJD",
    };

    await hydrateSendAttachmentParams({
      cfg: {} as OpenClawConfig,
      channel: "telegram",
      args,
      action: "send",
    });

    expect(args).toMatchObject({
      buffer: "QUJD",
      contentType: "image/png",
      filename: "attachment",
    });
  });
});
