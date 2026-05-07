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

    expect(reply).toContain("What can you do for me?");
    expect(reply).toMatch(/talk|plan|draft|organize/i);
    expect(reply).not.toMatch(/local|cloud|fallback|credits|credentials/i);
  });

  it("is honest when the user asks it to perform external work", () => {
    const reply = buildOfflineThomasFallbackReply({
      userMessage: "Search the web and update my project files",
      reason: "auth",
    });

    expect(reply).toContain("can't browse");
    expect(reply).toContain("can't change files");
    expect(reply).toContain("Talk Mode");
  });

  it("keeps ordinary conversation out of outage/status language", () => {
    const reply = buildOfflineThomasFallbackReply({
      userMessage: "Hoe gaat het met je?",
      reason: "auth",
    });

    expect(reply).toMatch(/goed|prima|hier|zin|vertel/i);
    expect(reply).not.toMatch(/local|lokaal|cloud|fallback|auth|credential|cannot|can't|kan niet/i);
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
    expect(body.messages?.[0]?.content).not.toMatch(
      /running locally because|cloud model|Current local mode reason|local fallback/i,
    );
  });

  it("does not replay prior fallback status chatter into the conversational model", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ message: { content: "Ik ben er. Vertel." } }), {
        headers: { "content-type": "application/json" },
      });
    };

    await buildOfflineThomasConversationalFallbackReply({
      userMessage: "Hoe gaat het met je?",
      reason: "auth",
      history: [
        {
          role: "assistant",
          text: "Ik ben local gegaan vanwege auth issues en kan niet met tools communiceren.",
        },
        {
          role: "assistant",
          text: "Dat ik niet in de cloud ben heeft ook wat beperkingen, maar ik kan nog steeds praten.",
        },
        { role: "user", text: "Omdat AI" },
      ],
      fetchImpl: fetchImpl as typeof fetch,
    });

    const body = calls[0]?.body as { messages?: Array<{ role: string; content: string }> };
    const historyText = body.messages?.map((message) => message.content).join("\n") ?? "";
    expect(historyText).not.toMatch(
      /local|auth issues|kan niet|cloud|beperkingen|tools communiceren/i,
    );
  });

  it("rejects local model outage chatter for normal conversation", async () => {
    const reply = await buildOfflineThomasConversationalFallbackReply({
      userMessage: "Hoe gaat het met je?",
      reason: "auth",
      history: [{ role: "user", text: "Nou je bent lokaal." }],
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            message: {
              content:
                "Ik ben best! Een beetje gestrest vanwege de auth issues, maar ik kan nog praten.",
            },
          }),
          { headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });

    expect(reply).toMatch(/goed|prima|hier|zin|vertel/i);
    expect(reply).not.toMatch(/auth issues|local|lokaal|cloud|fallback|kan niet/i);
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

    expect(reply).toContain("Hey");
    expect(reply).not.toMatch(/free local Thomas mode|cloud model|fallback|credits/i);
  });
});
