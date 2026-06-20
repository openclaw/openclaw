// Tests for provider change handling in session origin merging
import { describe, expect, it } from "vitest";
import { mergeOrigin } from "./metadata.js";
import type { SessionOrigin } from "./types.js";

describe("mergeOrigin", () => {
  describe("provider unchanged", () => {
    it("preserves all fields when merging with same provider", () => {
      const existing: SessionOrigin = {
        provider: "slack",
        label: "existing label",
        nativeChannelId: "C12345",
        nativeDirectUserId: "U12345",
        accountId: "A12345",
        threadId: "T12345",
        surface: "dm",
        chatType: "direct",
        from: "slack:U12345",
        to: "slack:U67890",
      };
      const next: SessionOrigin = {
        provider: "slack",
        label: "updated label",
        nativeChannelId: "C99999",
      };
      const result = mergeOrigin(existing, next);
      expect(result).toMatchObject({
        provider: "slack",
        label: "updated label",
        nativeChannelId: "C99999",
        nativeDirectUserId: "U12345",
        accountId: "A12345",
        threadId: "T12345",
        surface: "dm",
        chatType: "direct",
        from: "slack:U12345",
        to: "slack:U67890",
      });
      // Ensure no extra undefined properties
      expect(Object.keys(result!).length).toBe(10);
    });

    it("preserves provider-specific fields when provider is unchanged but next does not provide them", () => {
      const existing: SessionOrigin = {
        provider: "telegram",
        nativeChannelId: "telegram:chat:123",
        nativeDirectUserId: "telegram:user:456",
        accountId: "telegram:account:789",
        threadId: "telegram:thread:101",
      };
      const next: SessionOrigin = {
        provider: "telegram",
        label: "new label",
      };
      const result = mergeOrigin(existing, next);
      expect(result?.nativeChannelId).toBe("telegram:chat:123");
      expect(result?.nativeDirectUserId).toBe("telegram:user:456");
      expect(result?.accountId).toBe("telegram:account:789");
      expect(result?.threadId).toBe("telegram:thread:101");
    });
  });

  describe("provider change", () => {
    it("clears provider-specific fields when switching from Slack to Telegram", () => {
      const existing: SessionOrigin = {
        provider: "slack",
        label: "Slack conversation",
        nativeChannelId: "C12345",
        nativeDirectUserId: "U12345",
        accountId: "A12345",
        threadId: "T12345",
        surface: "dm",
        chatType: "direct",
        from: "slack:U12345",
        to: "slack:U67890",
      };
      const next: SessionOrigin = {
        provider: "telegram",
        label: "Telegram chat",
        from: "telegram:123456",
        to: "telegram:789012",
      };
      const result = mergeOrigin(existing, next);
      expect(result?.provider).toBe("telegram");
      expect(result?.label).toBe("Telegram chat");
      // provider-specific fields are cleared
      expect(result?.nativeChannelId).toBeUndefined();
      expect(result?.nativeDirectUserId).toBeUndefined();
      expect(result?.accountId).toBeUndefined();
      expect(result?.threadId).toBeUndefined();
      // cross-provider fields are preserved from existing or updated from next
      expect(result?.surface).toBe("dm");
      expect(result?.chatType).toBe("direct");
      expect(result?.from).toBe("telegram:123456"); // updated from next
      expect(result?.to).toBe("telegram:789012"); // updated from next
    });

    it("clears provider-specific fields when switching from Telegram to Discord", () => {
      const existing: SessionOrigin = {
        provider: "telegram",
        nativeChannelId: "telegram:chat:123",
        nativeDirectUserId: "telegram:user:456",
        accountId: "telegram:account:789",
        threadId: "telegram:thread:101",
        label: "Telegram group",
      };
      const next: SessionOrigin = {
        provider: "discord",
        label: "Discord server",
        from: "discord:user:111",
      };
      const result = mergeOrigin(existing, next);
      expect(result?.nativeChannelId).toBeUndefined();
      expect(result?.nativeDirectUserId).toBeUndefined();
      expect(result?.accountId).toBeUndefined();
      expect(result?.threadId).toBeUndefined();
      expect(result?.provider).toBe("discord");
      expect(result?.label).toBe("Discord server");
    });

    it("clears fields when provider changes from defined to undefined", () => {
      const existing: SessionOrigin = {
        provider: "slack",
        nativeChannelId: "C12345",
        nativeDirectUserId: "U12345",
        accountId: "A12345",
        threadId: "T12345",
      };
      const next: SessionOrigin = {
        label: "No provider",
      };
      const result = mergeOrigin(existing, next);
      // provider-specific fields cleared
      expect(result?.nativeChannelId).toBeUndefined();
      expect(result?.nativeDirectUserId).toBeUndefined();
      expect(result?.accountId).toBeUndefined();
      expect(result?.threadId).toBeUndefined();
      // Note: existing.provider is kept when next.provider is undefined
      // because providerChanged = existing.provider !== next.provider  (undefined !== "slack")
      // This is the current behavior change - we need to verify if this is desired
      expect(result?.provider).toBe("slack"); // provider stays from existing
      expect(result?.label).toBe("No provider");
    });

    it("clears fields when provider changes from undefined to defined", () => {
      const existing: SessionOrigin = {
        label: "Existing",
        nativeChannelId: "some-channel",
      };
      const next: SessionOrigin = {
        provider: "telegram",
        label: "New",
      };
      const result = mergeOrigin(existing, next);
      expect(result?.nativeChannelId).toBeUndefined();
      expect(result?.nativeDirectUserId).toBeUndefined();
      expect(result?.accountId).toBeUndefined();
      expect(result?.threadId).toBeUndefined();
      expect(result?.provider).toBe("telegram");
      expect(result?.label).toBe("New");
    });
  });

  describe("preserves cross-provider fields", () => {
    it("preserves label, surface (if present), chatType (if present), from, to", () => {
      const existing: SessionOrigin = {
        provider: "slack",
        label: "Test",
        surface: "dm",
        chatType: "direct",
        from: "slack:U123",
        to: "slack:U456",
      };
      const next: SessionOrigin = {
        provider: "discord",
        label: "Updated Test",
        surface: "dm",
        chatType: "direct",
        from: "discord:U789",
        to: "discord:U101",
      };
      const result = mergeOrigin(existing, next);
      expect(result?.label).toBe("Updated Test");
      expect(result?.surface).toBe("dm");
      expect(result?.chatType).toBe("direct");
      expect(result?.from).toBe("discord:U789");
      expect(result?.to).toBe("discord:U101");
    });
  });

  describe("boundary cases", () => {
    it("handles undefined existing", () => {
      const next: SessionOrigin = {
        provider: "telegram",
        label: "New session",
        nativeChannelId: "telegram:chat:123",
      };
      const result = mergeOrigin(undefined, next);
      expect(result).toEqual({
        provider: "telegram",
        label: "New session",
        nativeChannelId: "telegram:chat:123",
      });
    });

    it("handles undefined next", () => {
      const existing: SessionOrigin = {
        provider: "slack",
        nativeChannelId: "C12345",
      };
      const result = mergeOrigin(existing, undefined);
      // When next is undefined, that's a provider change (existing has provider),
      // so provider-specific fields should be cleared
      expect(result?.provider).toBe("slack");
      expect(result?.nativeChannelId).toBeUndefined();
    });

    it("returns undefined when both are undefined", () => {
      const result = mergeOrigin(undefined, undefined);
      expect(result).toBeUndefined();
    });

    it("clears threadId specifically when provider changes", () => {
      const existing: SessionOrigin = {
        provider: "slack",
        threadId: "12345_67890",
      };
      const next: SessionOrigin = {
        provider: "telegram",
      };
      const result = mergeOrigin(existing, next);
      expect(result?.threadId).toBeUndefined();
    });

    it("preserves threadId when provider unchanged and next provides null/empty threadId", () => {
      const existing: SessionOrigin = {
        provider: "telegram",
        threadId: "existing-thread",
      };
      const next: SessionOrigin = {
        provider: "telegram",
        threadId: "",
      };
      // According to deriveSessionOrigin, empty string should not override
      const result = mergeOrigin(existing, next);
      expect(result?.threadId).toBe("existing-thread");
    });
  });
});
