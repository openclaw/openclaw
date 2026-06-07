import { describe, expect, it } from "vitest";
import {
  compileDirectPeerConversation,
  isDirectPeerBinding,
  matchDirectPeerConversation,
  type NormalizePeerId,
} from "./direct-peer-binding.js";

// A sample channel-specific normalizer: strips an optional `user:` prefix and
// keeps only lowercase alphanumeric ids.
const customNormalizePeerId: NormalizePeerId = (id) => {
  const trimmed = id.trim().replace(/^user:/i, "");
  return /^[a-z0-9]+$/i.test(trimmed) ? trimmed.toLowerCase() : null;
};

describe("isDirectPeerBinding", () => {
  it("returns true for the canonical direct kind", () => {
    expect(isDirectPeerBinding("direct")).toBe(true);
  });

  it("returns true for the legacy dm alias", () => {
    expect(isDirectPeerBinding("dm")).toBe(true);
  });

  it("trims and lowercases the kind", () => {
    expect(isDirectPeerBinding("  DIRECT ")).toBe(true);
    expect(isDirectPeerBinding(" Dm")).toBe(true);
  });

  it("returns false for group/channel/unset kinds", () => {
    expect(isDirectPeerBinding("group")).toBe(false);
    expect(isDirectPeerBinding("channel")).toBe(false);
    expect(isDirectPeerBinding(undefined)).toBe(false);
    expect(isDirectPeerBinding("")).toBe(false);
  });
});

describe("compileDirectPeerConversation", () => {
  it("compiles to the trimmed peer id with no parent by default", () => {
    expect(compileDirectPeerConversation({ conversationId: "  peer-1 " })).toEqual({
      conversationId: "peer-1",
      parentConversationId: undefined,
    });
  });

  it("returns null for a blank id with the default normalizer", () => {
    expect(compileDirectPeerConversation({ conversationId: "   " })).toBeNull();
  });

  it("applies a custom normalizer", () => {
    expect(
      compileDirectPeerConversation({
        conversationId: "user:ABC123",
        normalizePeerId: customNormalizePeerId,
      }),
    ).toEqual({
      conversationId: "abc123",
      parentConversationId: undefined,
    });
  });

  it("returns null when the custom normalizer rejects the id", () => {
    expect(
      compileDirectPeerConversation({
        conversationId: "not a valid id",
        normalizePeerId: customNormalizePeerId,
      }),
    ).toBeNull();
  });
});

describe("matchDirectPeerConversation", () => {
  it("matches an inbound id with no parent against the binding id", () => {
    expect(
      matchDirectPeerConversation({
        bindingConversationId: "peer-1",
        conversationId: "peer-1",
      }),
    ).toEqual({
      conversationId: "peer-1",
      parentConversationId: undefined,
      matchPriority: 2,
    });
  });

  it("rejects an inbound that carries a parent conversation", () => {
    expect(
      matchDirectPeerConversation({
        bindingConversationId: "peer-1",
        conversationId: "peer-1",
        parentConversationId: "room-9",
      }),
    ).toBeNull();
  });

  it("returns null when the normalized ids differ", () => {
    expect(
      matchDirectPeerConversation({
        bindingConversationId: "peer-1",
        conversationId: "peer-2",
      }),
    ).toBeNull();
  });

  it("matches via a custom normalizer", () => {
    expect(
      matchDirectPeerConversation({
        bindingConversationId: "user:ABC123",
        conversationId: "abc123",
        normalizePeerId: customNormalizePeerId,
      }),
    ).toEqual({
      conversationId: "abc123",
      parentConversationId: undefined,
      matchPriority: 2,
    });
  });

  it("returns null when the custom normalizer rejects the binding id", () => {
    expect(
      matchDirectPeerConversation({
        bindingConversationId: "not valid",
        conversationId: "abc123",
        normalizePeerId: customNormalizePeerId,
      }),
    ).toBeNull();
  });

  it("honors an overridden match priority", () => {
    expect(
      matchDirectPeerConversation({
        bindingConversationId: "peer-1",
        conversationId: "peer-1",
        matchPriority: 5,
      }),
    ).toEqual({
      conversationId: "peer-1",
      parentConversationId: undefined,
      matchPriority: 5,
    });
  });
});
