import { describe, expect, it } from "vitest";
import {
  isCustomProvider,
  loadRecentChatModels,
  rememberRecentChatModel,
  sortRankedChatModelOptions,
} from "./chat-model-recents.ts";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("chat-model-recents", () => {
  it("stores most recent models first", () => {
    const storage = new MemoryStorage();
    rememberRecentChatModel("openai/gpt-5", storage, 100);
    rememberRecentChatModel("anthropic/claude-sonnet", storage, 200);

    expect(loadRecentChatModels(storage)).toEqual([
      { value: "anthropic/claude-sonnet", usedAt: 200 },
      { value: "openai/gpt-5", usedAt: 100 },
    ]);
  });

  it("deduplicates and bumps existing models to the front", () => {
    const storage = new MemoryStorage();
    rememberRecentChatModel("openai/gpt-5", storage, 100);
    rememberRecentChatModel("anthropic/claude-sonnet", storage, 200);
    rememberRecentChatModel("openai/gpt-5", storage, 300);

    expect(loadRecentChatModels(storage)).toEqual([
      { value: "openai/gpt-5", usedAt: 300 },
      { value: "anthropic/claude-sonnet", usedAt: 200 },
    ]);
  });

  it("treats unknown providers as custom", () => {
    expect(isCustomProvider("openai")).toBe(false);
    expect(isCustomProvider("anthropic")).toBe(false);
    expect(isCustomProvider("my-company")).toBe(true);
  });

  it("sorts recent first, then custom providers, then remaining models", () => {
    const ranked = sortRankedChatModelOptions(
      [
        {
          value: "openai/gpt-5",
          label: "OpenAI / GPT-5",
          provider: "openai",
          isCustomProvider: false,
        },
        {
          value: "custom/foo",
          label: "Custom / Foo",
          provider: "custom",
          isCustomProvider: true,
        },
        {
          value: "anthropic/claude-sonnet",
          label: "Anthropic / Claude Sonnet",
          provider: "anthropic",
          isCustomProvider: false,
        },
      ],
      [{ value: "anthropic/claude-sonnet", usedAt: 100 }],
    );

    expect(ranked.map((entry) => entry.value)).toEqual([
      "anthropic/claude-sonnet",
      "custom/foo",
      "openai/gpt-5",
    ]);
  });

  it("does not duplicate a recent custom-provider model", () => {
    const ranked = sortRankedChatModelOptions(
      [
        {
          value: "custom/foo",
          label: "Custom / Foo",
          provider: "custom",
          isCustomProvider: true,
        },
        {
          value: "openai/gpt-5",
          label: "OpenAI / GPT-5",
          provider: "openai",
          isCustomProvider: false,
        },
      ],
      [{ value: "custom/foo", usedAt: 100 }],
    );

    expect(ranked.map((entry) => entry.value)).toEqual(["custom/foo", "openai/gpt-5"]);
  });
});
