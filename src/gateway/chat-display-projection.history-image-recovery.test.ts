import { describe, expect, it } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

describe("historical image recovery projection", () => {
  it("projects legacy inline images as recoverable artifacts without returning their bytes", () => {
    const encoded = createNoisyPngBuffer(1, 1).toString("base64");
    const [message] = projectChatDisplayMessages([
      {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: encoded }],
      },
    ]);

    expect(message).toMatchObject({
      role: "user",
      content: [
        {
          type: "image",
          mimeType: "image/png",
          artifactId: expect.stringMatching(/^artifact_history_image_/u),
          url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\/__history__\//u),
          omitted: true,
          bytes: Buffer.from(encoded, "base64").length,
        },
      ],
    });
    expect(JSON.stringify(message)).not.toContain(encoded);
  });

  it("does not advertise recovery for malformed or non-image historical bytes", () => {
    const [message] = projectChatDisplayMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("not an image").toString("base64"),
          },
        ],
      },
    ]);
    const block = (message as { content: Array<Record<string, unknown>> }).content[0];

    expect(block).toMatchObject({ type: "image", omitted: true });
    expect(block).not.toHaveProperty("artifactId");
    expect(block).not.toHaveProperty("url");
  });
});
