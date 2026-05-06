import { describe, expect, it } from "vitest";
import {
  buildOfflineThomasFallbackReply,
  buildOfflineThomasConversationalFallbackReply,
  shouldUseOfflineThomasFallback,
} from "./offline-thomas-fallback.js";

describe("offline Thomas fallback", () => {
  it("recognizes provider quota and billing messages as fallback candidates", () => {
    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "hello",
        assistantTexts: [
          "API provider returned a billing error - your API key has run out of credits.",
        ],
      }),
    ).toBe(true);

    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "hello",
        assistantTexts: ["You exceeded your current quota, please check your plan and billing."],
      }),
    ).toBe(true);
  });

  it("does not replace normal assistant text or slash command replies", () => {
    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "hello",
        assistantTexts: ["Hello right back."],
      }),
    ).toBe(false);

    expect(
      shouldUseOfflineThomasFallback({
        userMessage: "/context list",
        assistantTexts: ["API provider returned a billing error."],
      }),
    ).toBe(false);
  });

  it("builds a transparent, conversational local reply", () => {
    const reply = buildOfflineThomasFallbackReply({
      userMessage: "What can you do for me?",
      reason: "billing",
    });

    expect(reply).toContain("free local Thomas mode");
    expect(reply).toContain("cloud model");
    expect(reply).toContain("What can you do for me?");
    expect(reply).toMatch(/talk|plan|draft|organize/i);
  });

  it("is honest when the user asks it to perform external work", () => {
    const reply = buildOfflineThomasFallbackReply({
      userMessage: "Search the web and update my project files",
      reason: "auth",
    });

    expect(reply).toContain("can't browse");
    expect(reply).toContain("can't change files");
    expect(reply).toContain("local");
  });

  it("uses a local conversational model with recent history when available", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify({
          message: {
            content: "I remember Moos. Let's make this practical.",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };

    const reply = await buildOfflineThomasConversationalFallbackReply({
      userMessage: "What should I do next?",
      reason: "billing",
      history: [
        { role: "user", text: "My cat is Moos." },
        { role: "assistant", text: "Moos noted." },
      ],
      model: "llama3.2:3b",
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(reply).toBe("I remember Moos. Let's make this practical.");
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0]?.body).toMatchObject({
      model: "llama3.2:3b",
      stream: false,
    });
    const body = calls[0]?.body as { messages?: Array<{ role: string; content: string }> };
    expect(body.messages?.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages?.[1]?.content).toContain("My cat is Moos.");
    expect(body.messages?.[3]?.content).toBe("What should I do next?");
  });

  it("falls back to the static local reply when the local model is disabled", async () => {
    const reply = await buildOfflineThomasConversationalFallbackReply({
      userMessage: "Hey",
      reason: "billing",
      disableLocalModel: true,
      fetchImpl: (() => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });

    expect(reply).toContain("free local Thomas mode");
    expect(reply).toContain("Hey");
  });
});
