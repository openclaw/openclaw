import { describe, it, expect } from "vitest";
import {
  markHomeTabCustom,
  clearHomeTabCustom,
  hasCustomHomeTab,
  markHomeTabPublished,
  hasCurrentHomeTab,
  isPublishInFlight,
  markPublishInFlight,
  clearPublishInFlight,
} from "./home-tab-state.js";

const ACCOUNT = "default";

describe("home-tab-state", () => {
  it("tracks custom view per account+user", () => {
    markHomeTabCustom(ACCOUNT, "U1");
    expect(hasCustomHomeTab(ACCOUNT, "U1")).toBe(true);
    expect(hasCustomHomeTab(ACCOUNT, "U2")).toBe(false);
    clearHomeTabCustom(ACCOUNT, "U1");
    expect(hasCustomHomeTab(ACCOUNT, "U1")).toBe(false);
  });

  it("tracks published version per account+user", () => {
    markHomeTabPublished(ACCOUNT, "U1", "1.0.0");
    expect(hasCurrentHomeTab(ACCOUNT, "U1", "1.0.0")).toBe(true);
    expect(hasCurrentHomeTab(ACCOUNT, "U1", "2.0.0")).toBe(false);
    expect(hasCurrentHomeTab(ACCOUNT, "U2", "1.0.0")).toBe(false);
  });

  it("markHomeTabCustom clears published version", () => {
    markHomeTabPublished(ACCOUNT, "U3", "1.0.0");
    expect(hasCurrentHomeTab(ACCOUNT, "U3", "1.0.0")).toBe(true);
    markHomeTabCustom(ACCOUNT, "U3");
    expect(hasCurrentHomeTab(ACCOUNT, "U3", "1.0.0")).toBe(false);
  });

  it("clearHomeTabCustom does not restore published version", () => {
    markHomeTabPublished(ACCOUNT, "U4", "1.0.0");
    markHomeTabCustom(ACCOUNT, "U4");
    clearHomeTabCustom(ACCOUNT, "U4");
    expect(hasCurrentHomeTab(ACCOUNT, "U4", "1.0.0")).toBe(false);
  });

  it("clears custom independently per user", () => {
    markHomeTabCustom(ACCOUNT, "U5");
    markHomeTabCustom(ACCOUNT, "U6");
    clearHomeTabCustom(ACCOUNT, "U5");
    expect(hasCustomHomeTab(ACCOUNT, "U5")).toBe(false);
    expect(hasCustomHomeTab(ACCOUNT, "U6")).toBe(true);
    clearHomeTabCustom(ACCOUNT, "U6");
  });

  it("isolates state across different accounts", () => {
    markHomeTabCustom("account-a", "U1");
    markHomeTabPublished("account-b", "U1", "1.0.0");
    expect(hasCustomHomeTab("account-a", "U1")).toBe(true);
    expect(hasCustomHomeTab("account-b", "U1")).toBe(false);
    expect(hasCurrentHomeTab("account-a", "U1", "1.0.0")).toBe(false);
    expect(hasCurrentHomeTab("account-b", "U1", "1.0.0")).toBe(true);
    clearHomeTabCustom("account-a", "U1");
  });

  it("tracks in-flight publish state", () => {
    expect(isPublishInFlight(ACCOUNT, "U1")).toBe(false);
    markPublishInFlight(ACCOUNT, "U1");
    expect(isPublishInFlight(ACCOUNT, "U1")).toBe(true);
    expect(isPublishInFlight(ACCOUNT, "U2")).toBe(false);
    clearPublishInFlight(ACCOUNT, "U1");
    expect(isPublishInFlight(ACCOUNT, "U1")).toBe(false);
  });
});
