import { expect, it } from "vitest";
import { toForwardableResponseHeaders } from "./response-headers.js";

const CJK_NAME = "附件_2026-09-21.log";
const CJK_DISPOSITION =
  "attachment; filename=\"___2026-09-21.log\"; filename*=UTF-8''%E9%99%84%E4%BB%B6_2026-09-21.log";
// IncomingMessage exposes received UTF-8 header bytes as latin1 characters.
const received = (value: string) => Buffer.from(value, "utf8").toString("latin1");
it("normalizes disposition variants while preserving opaque response headers", () => {
  // Opaque validators such as ETag must retain their received bytes.
  const headers = {
    "content-length": "4",
    "set-cookie": ["a=1", "b=2"],
    etag: `"${received("café")}"`,
    "x-file-name": received("附件.log"),
  };
  const extended = "UTF-8''caf%C3%A9-%E6%97%A5%E6%9C%AC.txt";
  const cases: [string, string][] = [
    ['attachment; filename="report.pdf"', 'attachment; filename="report.pdf"'],
    [`attachment; filename="${CJK_NAME}"`, CJK_DISPOSITION],
    [`attachment; filename=${received(CJK_NAME)}`, CJK_DISPOSITION],
    [
      'inline; filename="café.txt"',
      "inline; filename=\"caf_.txt\"; filename*=UTF-8''caf%C3%A9.txt",
    ],
    [
      `attachment; filename="${received("café.txt")}"; size=4; filename*=${extended}`,
      `attachment; size=4; filename="caf_.txt"; filename*=${extended}`,
    ],
    [received("attachment; note=附"), "attachment"],
    [received("附件"), "__"],
  ];
  for (const [input, expected] of cases) {
    expect(toForwardableResponseHeaders({ ...headers, "content-disposition": input })).toEqual({
      ...headers,
      "content-disposition": expected,
    });
  }
});
