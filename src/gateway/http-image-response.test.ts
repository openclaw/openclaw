import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpImageRepresentation, sendHttpImageResponse } from "./http-image-response.js";

describe("sendHttpImageResponse", () => {
  it("keeps an ascii filename unchanged", () => {
    const request = new IncomingMessage(new Socket());
    request.on("error", () => {});
    const response = new ServerResponse(request);
    sendHttpImageResponse({
      req: request,
      res: response,
      image: createHttpImageRepresentation(Buffer.from("png-bytes"), "image/png"),
      filename: "avatar",
    });
    expect(response.statusCode).toBe(200);
    expect(response.getHeader("content-disposition")).toBe('attachment; filename="avatar"');
  });

  it("re-encodes a non-Latin-1 filename so the header stays writable", () => {
    const request = new IncomingMessage(new Socket());
    request.on("error", () => {});
    const response = new ServerResponse(request);
    sendHttpImageResponse({
      req: request,
      res: response,
      image: createHttpImageRepresentation(Buffer.from("png-bytes"), "image/png"),
      filename: "附件.png",
    });
    expect(response.statusCode).toBe(200);
    expect(response.getHeader("content-disposition")).toBe(
      "attachment; filename=\"__.png\"; filename*=UTF-8''%E9%99%84%E4%BB%B6.png",
    );
  });
});
