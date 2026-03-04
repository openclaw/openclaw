import { request } from "gaxios";
import { describe, expect, it } from "vitest";

describe("gaxios fetch fallback regression", () => {
  it("can issue requests without node-fetch import crashes", async () => {
    const response = await request<string>({
      url: "data:text/plain,ok",
    });

    expect(response.status).toBe(200);
    expect(response.data).toBe("ok");
  });
});
