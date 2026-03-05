import { describe, it, expect, beforeEach } from "vitest";
import {
  recordSentMessage,
  wasSentByBot,
  clearSentMessageCache,
} from "./sent-message-cache.js";

describe("sent-message-cache", () => {
  beforeEach(() => {
    clearSentMessageCache();
  });

  it("records and checks sent messages", () => {
    recordSentMessage(123, 456);
    expect(wasSentByBot(123, 456)).toBe(true);
    expect(wasSentByBot(123, 789)).toBe(false);
  });

  it("respects MAX_CHATS limit by evicting oldest", () => {
    // Fill cache to capacity (5000 chats)
    for (let i = 0; i < 5000; i++) {
      recordSentMessage(i, 1);
    }
    
    // First chat should still exist
    expect(wasSentByBot(0, 1)).toBe(true);
    
    // Add one more chat - should evict chat 0
    recordSentMessage(5000, 1);
    
    // Chat 0 should be evicted
    expect(wasSentByBot(0, 1)).toBe(false);
    // New chat should exist
    expect(wasSentByBot(5000, 1)).toBe(true);
  });

  it("does not evict when updating existing chat", () => {
    // Fill to capacity
    for (let i = 0; i < 5000; i++) {
      recordSentMessage(i, 1);
    }
    
    // Update existing chat (should not trigger eviction)
    recordSentMessage(100, 2);
    
    // Chat 0 should still exist
    expect(wasSentByBot(0, 1)).toBe(true);
    // Chat 100 should have both messages
    expect(wasSentByBot(100, 1)).toBe(true);
    expect(wasSentByBot(100, 2)).toBe(true);
  });

  it("implements true LRU: recently accessed chats survive eviction", () => {
    // Fill to capacity
    for (let i = 0; i < 5000; i++) {
      recordSentMessage(i, 1);
    }
    
    // Access chat 0 (moves it to end)
    expect(wasSentByBot(0, 1)).toBe(true);
    
    // Add new chat - should evict chat 1 (oldest), not chat 0 (recently accessed)
    recordSentMessage(5000, 1);
    
    expect(wasSentByBot(0, 1)).toBe(true);  // Recently accessed, should survive
    expect(wasSentByBot(1, 1)).toBe(false); // Oldest unaccessed, should be evicted
    expect(wasSentByBot(5000, 1)).toBe(true);
  });
});
