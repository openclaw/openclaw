import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { saveMediaBuffer } from "../media/store.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("inbound attachment download filenames", () => {
  it.each([
    { hint: undefined, expected: "café_雪.txt" },
    { hint: "café 雪 🦞.txt", expected: "café 雪 🦞.txt" },
    { hint: "../folder\\café 雪 🦞\r\n.txt", expected: "café 雪 🦞__.txt" },
    { hint: "..", expected: "café_雪.txt" },
  ])("serves inbound media with filename hint $hint", async ({ hint, expected }) => {
    const bytes = Buffer.from("café|雪|🦞\r\n139+241=380\r\n");
    const saved = await saveMediaBuffer(
      bytes,
      "text/plain",
      "inbound",
      undefined,
      "café 雪 🦞.txt",
    );
    const params = new URLSearchParams({
      source: `media://inbound/${saved.id}`,
      token: "test-token",
    });
    if (hint !== undefined) {
      params.set("filename", hint);
    }
    try {
      const { res } = makeMockHttpResponse();
      const handled = await handleControlUiAssistantMediaRequest(
        {
          url: `/__openclaw__/assistant-media?${params}`,
          method: "GET",
          headers: {},
          headersDistinct: {},
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
        res,
        { auth: { mode: "token", token: "test-token", allowTailscale: false } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(res["setHeader"]).toHaveBeenCalledWith(
        "Content-Disposition",
        buildAssistantMediaContentDisposition(expected, "text/plain"),
      );
    } finally {
      await fs.rm(saved.path, { force: true });
    }
  });
});
