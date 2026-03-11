import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clackNoteMock } = vi.hoisted(() => ({
  clackNoteMock: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  note: clackNoteMock,
}));

describe("note", () => {
  const originalSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;

  beforeEach(() => {
    clackNoteMock.mockClear();
    delete process.env.OPENCLAW_SUPPRESS_NOTES;
  });

  afterEach(() => {
    if (originalSuppressNotes === undefined) {
      delete process.env.OPENCLAW_SUPPRESS_NOTES;
    } else {
      process.env.OPENCLAW_SUPPRESS_NOTES = originalSuppressNotes;
    }
    vi.resetModules();
  });

  it("applies an explicit foreground color to note bodies in rich terminals", async () => {
    vi.doMock("./prompt-style.js", () => ({
      stylePromptTitle: (value?: string) => value,
    }));
    vi.doMock("./theme.js", () => ({
      isRich: () => true,
      theme: { body: (value: string) => `body:${value}` },
    }));

    const { note } = await import("./note.js");
    note("Provider notes go here", "Provider notes");

    const renderedMessage = clackNoteMock.mock.calls[0]?.[0];
    expect(renderedMessage).toBe("body:Provider notes go here");
  });

  it("leaves note bodies unstyled when colors are disabled", async () => {
    vi.doMock("./prompt-style.js", () => ({
      stylePromptTitle: (value?: string) => value,
    }));
    vi.doMock("./theme.js", () => ({
      isRich: () => false,
      theme: { body: (value: string) => `body:${value}` },
    }));

    const { note } = await import("./note.js");
    note("Plain output", "Plain");

    expect(clackNoteMock).toHaveBeenCalledWith("Plain output", "Plain");
  });
});
