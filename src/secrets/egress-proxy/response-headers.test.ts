import { describe, expect, it } from "vitest";
import { toForwardableResponseHeaders } from "./response-headers.js";

const CJK_NAME = "附件_2026-09-21.log";
const CJK_DISPOSITION =
  "attachment; filename=\"___2026-09-21.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6_2026-09-21.log";
// IncomingMessage exposes received UTF-8 header bytes as latin1 characters.
const received = (value: string) => Buffer.from(value, "utf8").toString("latin1");
const disposition = (value: string) =>
  toForwardableResponseHeaders({ "content-disposition": value })["content-disposition"];

describe("toForwardableResponseHeaders", () => {
  it("keeps ASCII headers unchanged", () => {
    const headers = {
      "content-length": "4",
      "content-disposition": 'attachment; filename="report.pdf"',
      "set-cookie": ["a=1", "b=2"],
    };
    expect(toForwardableResponseHeaders(headers)).toBe(headers);
  });

  it("forwards non-ASCII bytes in other headers unchanged", () => {
    // Node writes these latin1 values back byte-for-byte; rewriting them would
    // change opaque validators such as ETag used by If-Match/If-None-Match.
    const headers = {
      "content-length": "4",
      etag: `"${received("café")}"`,
      "x-file-name": received("附件.log"),
    };
    expect(toForwardableResponseHeaders(headers)).toEqual(headers);
  });

  it.each([
    ["received UTF-8 bytes", `attachment; filename="${received(CJK_NAME)}"`],
    ["decoded characters", `attachment; filename="${CJK_NAME}"`],
    ["an unquoted filename", `attachment; filename=${received(CJK_NAME)}`],
  ])("encodes a CJK filename from %s with RFC 6266 filename*", (_label, value) => {
    expect(disposition(value)).toBe(CJK_DISPOSITION);
  });

  it("keeps the disposition type and a latin1 filename that is not UTF-8", () => {
    expect(disposition('inline; filename="café.txt"')).toBe(
      "inline; filename=\"caf_.txt\"; filename*=UTF-8''caf%C3%A9.txt",
    );
  });

  it("keeps an upstream filename* and other ASCII parameters", () => {
    const extended = "UTF-8''caf%C3%A9-%E6%97%A5%E6%9C%AC.txt";
    expect(
      disposition(`attachment; filename="${received("café.txt")}"; size=4; filename*=${extended}`),
    ).toBe(`attachment; size=4; filename="caf_.txt"; filename*=${extended}`);
  });

  it("drops non-ASCII parameters it cannot keep", () => {
    expect(disposition(received("attachment; note=附"))).toBe("attachment");
    expect(disposition(received("附件"))).toBe("__");
  });
});
