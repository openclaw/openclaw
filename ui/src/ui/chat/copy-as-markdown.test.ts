import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the clipboard fallback logic in copy-as-markdown.ts.
 * We replicate the helper inline because it is not exported.
 */

function createMockDocument() {
  const textarea = {
    value: "",
    style: { position: "", left: "", opacity: "" } as CSSStyleDeclaration,
    select: vi.fn(),
  };
  return {
    textarea,
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => true),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  };
}

async function copyTextToClipboard(
  text: string,
  doc: ReturnType<typeof createMockDocument>,
): Promise<boolean> {
  if (!text) {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API unavailable or blocked
  }

  try {
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand("copy");
    doc.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

describe("copyTextToClipboard", () => {
  let originalClipboard: Clipboard;
  let mockDoc: ReturnType<typeof createMockDocument>;

  beforeEach(() => {
    originalClipboard = navigator.clipboard;
    mockDoc = createMockDocument();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
  });

  it("returns false for empty text", async () => {
    expect(await copyTextToClipboard("", mockDoc)).toBe(false);
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    const result = await copyTextToClipboard("hello", mockDoc);
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when clipboard API throws", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("blocked")),
      },
      writable: true,
      configurable: true,
    });

    mockDoc.execCommand.mockReturnValue(true);
    const result = await copyTextToClipboard("fallback text", mockDoc);
    expect(result).toBe(true);
    expect(mockDoc.execCommand).toHaveBeenCalledWith("copy");
    expect(mockDoc.textarea.select).toHaveBeenCalled();
  });

  it("falls back to execCommand when clipboard API is undefined", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    mockDoc.execCommand.mockReturnValue(true);
    const result = await copyTextToClipboard("fallback text", mockDoc);
    expect(result).toBe(true);
    expect(mockDoc.execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when both clipboard API and execCommand fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    mockDoc.execCommand.mockReturnValue(false);
    const result = await copyTextToClipboard("fail", mockDoc);
    expect(result).toBe(false);
  });
});
