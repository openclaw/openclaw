import type { Message } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { resolveReplyContext } from "./reply-context.js";

describe("resolveReplyContext", () => {
  const mockResolveText = vi.fn();

  it("returns null if no referenced message", async () => {
    const message = { referencedMessage: null } as unknown as Message;
    const result = await resolveReplyContext(message, mockResolveText);
    expect(result).toBeNull();
  });

  it("returns null if referenced message has no author", async () => {
    const message = {
      referencedMessage: { author: null },
    } as unknown as Message;
    const result = await resolveReplyContext(message, mockResolveText);
    expect(result).toBeNull();
  });

  it("returns context if referenced message has content", async () => {
    const referencedMessage = {
      id: "ref-1",
      channelId: "chan-1",
      author: { id: "user-1", username: "user1", globalName: "User One" },
      content: "hello world",
      timestamp: "2023-01-01T00:00:00Z",
    };
    const message = {
      referencedMessage,
    } as unknown as Message;

    mockResolveText.mockReturnValue("hello world");

    const result = await resolveReplyContext(message, mockResolveText);
    expect(result).toEqual({
      id: "ref-1",
      channelId: "chan-1",
      sender: "user1",
      body: "hello world",
      timestamp: expect.any(Number),
    });
  });

  it("fetches full message via REST if content is missing (Gateway partial)", async () => {
    const referencedMessage = {
      id: "ref-1",
      channelId: "chan-1",
      author: { id: "user-1", username: "user1", globalName: "User One" },
      content: "", // Empty content from Gateway partial
      timestamp: "2023-01-01T00:00:00Z",
    };
    const message = {
      referencedMessage,
    } as unknown as Message;

    mockResolveText.mockReturnValue(""); // Empty content

    const mockClient = {
      rest: {
        get: vi.fn().mockResolvedValue({ content: "fetched content" }),
      },
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = await resolveReplyContext(message, mockResolveText, mockClient as any);
    expect(mockClient.rest.get).toHaveBeenCalledWith(Routes.channelMessage("chan-1", "ref-1"));
    expect(result).toEqual({
      id: "ref-1",
      channelId: "chan-1",
      sender: "user1",
      body: "fetched content",
      timestamp: expect.any(Number),
    });
  });

  it("returns null if REST fetch fails", async () => {
    const referencedMessage = {
      id: "ref-1",
      channelId: "chan-1",
      author: { id: "user-1", username: "user1", globalName: "User One" },
      content: "",
      timestamp: "2023-01-01T00:00:00Z",
    };
    const message = {
      referencedMessage,
    } as unknown as Message;

    mockResolveText.mockReturnValue("");

    const mockClient = {
      rest: {
        get: vi.fn().mockRejectedValue(new Error("REST error")),
      },
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    const result = await resolveReplyContext(message, mockResolveText, mockClient as any);
    expect(result).toBeNull();
  });
});
