import { describe, expect, it } from "vitest";
import {
  safeAttachmentHref,
  safeMediaAttachmentHref,
  safePlainTextAttachmentHref,
} from "./chat-attachment-href.ts";

describe("safeAttachmentHref", () => {
  it.each([
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//attacker.example/file.mp3",
  ])("rejects an unsafe attachment href: %s", (href) => {
    expect(safeAttachmentHref(href)).toBeUndefined();
  });
});

describe("safeMediaAttachmentHref", () => {
  it.each([
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:audio/wav;base64,not_base64",
    "data:audio/wav;base64,UklGRg=",
  ])("rejects an unsafe inline media href: %s", (href) => {
    expect(safeMediaAttachmentHref(href)).toBeUndefined();
  });

  it("requires the matching media kind when one is supplied", () => {
    expect(safeMediaAttachmentHref("data:video/mp4;base64,AAAA", "video")).toBe(
      "data:video/mp4;base64,AAAA",
    );
    expect(safeMediaAttachmentHref("data:audio/mp3;base64,AAAA", "video")).toBeUndefined();
  });
});

describe("safePlainTextAttachmentHref", () => {
  it.each([
    ["data:text/plain;base64,SGVsbG8=", true],
    ["data:text/html;base64,SGVsbG8=", false],
    ["data:text/plain;base64,SGVsbG8", false],
  ])("restricts inline pasted sources: %s", (href, allowed) => {
    expect(safePlainTextAttachmentHref(href)).toBe(allowed ? href : undefined);
  });
});
