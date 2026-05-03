import { describe, expect, it } from "vitest";
import { findRawHttp2ConnectCallLines } from "../../scripts/check-no-raw-http2-connect.mjs";

describe("check-no-raw-http2-connect", () => {
  it("finds direct http2.connect calls", () => {
    const source = `
      import http2 from "node:http2";
      export function connect() {
        return http2.connect("https://api.push.apple.com");
      }
    `;

    expect(findRawHttp2ConnectCallLines(source)).toEqual([4]);
  });

  it("finds parenthesized or asserted http2 references", () => {
    const source = `
      import http2 from "node:http2";
      export function connect() {
        return (http2 as typeof import("node:http2")).connect("https://api.push.apple.com");
      }
    `;

    expect(findRawHttp2ConnectCallLines(source)).toEqual([4]);
  });

  it("ignores mentions in strings and comments", () => {
    const source = `
      // http2.connect("https://api.push.apple.com")
      const text = "http2.connect('https://api.push.apple.com')";
    `;

    expect(findRawHttp2ConnectCallLines(source)).toEqual([]);
  });
});
