import { describe, expect, it } from "vitest";
import { toForwardableResponseHeaders } from "./response-headers.js";

const CJK_NAME = "附件_2026-09-21.log";
// IncomingMessage exposes received UTF-8 header bytes as latin1 characters.
const received = (value: string) => Buffer.from(value, "utf8").toString("latin1");

describe("toForwardableResponseHeaders", () => {
  it("keeps ASCII headers unchanged", () => {
    const headers = {
      "content-length": "4",
      "content-disposition": 'attachment; filename="report.pdf"',
      "set-cookie": ["a=1", "b=2"],
    };
    expect(toForwardableResponseHeaders(headers)).toEqual(headers);
  });

  it.each([
    ["received UTF-8 bytes", `attachment; filename="${received(CJK_NAME)}"`],
    ["decoded characters", `attachment; filename="${CJK_NAME}"`],
    ["an unquoted filename", `attachment; filename=${received(CJK_NAME)}`],
  ])("encodes a CJK filename from %s with RFC 6266 filename*", (_label, disposition) => {
    expect(
      toForwardableResponseHeaders({ "content-disposition": disposition })["content-disposition"],
    ).toBe(
      "attachment; filename=\"___2026-09-21.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6_2026-09-21.log",
    );
  });

  it("keeps the disposition type and a latin1 filename that is not UTF-8", () => {
    expect(
      toForwardableResponseHeaders({ "content-disposition": 'inline; filename="café.txt"' })[
        "content-disposition"
      ],
    ).toBe("inline; filename=\"caf_.txt\"; filename*=UTF-8''caf%C3%A9.txt");
  });

  it("replaces non-ASCII characters in other headers", () => {
    expect(
      toForwardableResponseHeaders({
        "x-file-name": received("附件.log"),
        "x-list": [received("é"), "ok"],
        "content-disposition": received("attachment; note=附"),
      }),
    ).toEqual({
      "x-file-name": "__.log",
      "x-list": ["_", "ok"],
      "content-disposition": "attachment; note=_",
    });
  });
});
