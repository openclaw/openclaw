// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inferBasePathFromPathname } from "../app-route-paths.ts";
import { resolveControlUiDocumentMode } from "./approval-deep-link.ts";

describe("approval document routing", () => {
  it.each(["/approve/%2E%2E", "/approve/id/extra"])(
    "keeps malformed approval-shaped paths shellless: %s",
    (pathname) => {
      expect(resolveControlUiDocumentMode(pathname, "")).toEqual({
        kind: "approval",
        approvalId: null,
      });
    },
  );
});

describe("question document routing", () => {
  it("resolves root and configured-base question links without changing approval routing", () => {
    expect(resolveControlUiDocumentMode("/ask/question%3A123", "")).toEqual({
      kind: "question",
      questionId: "question:123",
    });
    expect(resolveControlUiDocumentMode("/operator/ask/question%3A456", "/operator/")).toEqual({
      kind: "question",
      questionId: "question:456",
    });
    expect(resolveControlUiDocumentMode("/approve/approval%3A123", "")).toEqual({
      kind: "approval",
      approvalId: "approval:123",
    });
    expect(inferBasePathFromPathname("/ask/question%3A123")).toBe("");
    expect(inferBasePathFromPathname("/operator/ask/question%3A456")).toBe("/operator");
  });

  it.each(["/ask", "/ask/%"])("keeps malformed question-shaped paths shellless: %s", (pathname) => {
    expect(resolveControlUiDocumentMode(pathname, "")).toEqual({
      kind: "question",
      questionId: null,
    });
  });

  it("does not claim ordinary or out-of-mount paths", () => {
    expect(resolveControlUiDocumentMode("/chat", "")).toBeNull();
    expect(resolveControlUiDocumentMode("/ask/id", "/operator")).toBeNull();
  });
});
