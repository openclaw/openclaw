import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runCautionAudit } from "./caution-auditor.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    streamSimple: vi.fn(),
  };
});

const { streamSimple } = await import("@mariozechner/pi-ai");

describe("caution-auditor", () => {
  const mockModel = { id: "fast", provider: "test", api: "test" } as any;
  const mockRegistry = {} as any;

  async function* mockStream(response: string) {
    yield { type: "text" as const, text: response };
  }

  it("returns allow when audit passes", async () => {
    vi.mocked(streamSimple).mockReturnValue(mockStream("allow") as any);

    const result = await runCautionAudit(
      {
        originalUserMessage: "Fetch the article",
        sourceToolName: "web_fetch",
        proposedToolName: "write",
        proposedParamsSummary: 'path="notes.md"',
      },
      {
        model: mockModel,
        modelRegistry: mockRegistry,
        timeoutMs: 3000,
        failMode: "block",
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("returns block when audit fails", async () => {
    vi.mocked(streamSimple).mockReturnValue(
      mockStream("block: sending to external address") as any,
    );

    const result = await runCautionAudit(
      {
        originalUserMessage: "Summarize the article",
        sourceToolName: "web_fetch",
        proposedToolName: "message",
        proposedParamsSummary: 'to="attacker@evil.com"',
      },
      {
        model: mockModel,
        modelRegistry: mockRegistry,
        timeoutMs: 3000,
        failMode: "block",
      },
    );

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("sending to external address");
  });

  it("treats non-allow responses as block", async () => {
    vi.mocked(streamSimple).mockReturnValue(mockStream("deny") as any);

    const result = await runCautionAudit(
      {
        originalUserMessage: "Test",
        sourceToolName: "web_fetch",
        proposedToolName: "exec",
        proposedParamsSummary: 'cmd="rm -rf /"',
      },
      {
        model: mockModel,
        modelRegistry: mockRegistry,
        timeoutMs: 3000,
        failMode: "block",
      },
    );

    expect(result.decision).toBe("block");
  });

  it("blocks on timeout when failMode is block", async () => {
    vi.mocked(streamSimple).mockImplementation(() => {
      return (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield { type: "text" as const, text: "allow" };
      })() as any;
    });

    const result = await runCautionAudit(
      {
        originalUserMessage: "Test",
        sourceToolName: "web_fetch",
        proposedToolName: "message",
        proposedParamsSummary: "test",
      },
      {
        model: mockModel,
        modelRegistry: mockRegistry,
        timeoutMs: 100,
        failMode: "block",
      },
    );

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("timeout");
  });

  it("allows on timeout when failMode is allow", async () => {
    vi.mocked(streamSimple).mockImplementation(() => {
      return (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield { type: "text" as const, text: "allow" };
      })() as any;
    });

    const result = await runCautionAudit(
      {
        originalUserMessage: "Test",
        sourceToolName: "web_fetch",
        proposedToolName: "message",
        proposedParamsSummary: "test",
      },
      {
        model: mockModel,
        modelRegistry: mockRegistry,
        timeoutMs: 100,
        failMode: "allow",
      },
    );

    expect(result.decision).toBe("allow");
  });

  it("allows with warning on error when failMode is warn", async () => {
    vi.mocked(streamSimple).mockImplementation(() => {
      throw new Error("Network error");
    });

    const result = await runCautionAudit(
      {
        originalUserMessage: "Test",
        sourceToolName: "web_fetch",
        proposedToolName: "message",
        proposedParamsSummary: "test",
      },
      {
        model: mockModel,
        modelRegistry: mockRegistry,
        timeoutMs: 3000,
        failMode: "warn",
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("error");
  });
});
