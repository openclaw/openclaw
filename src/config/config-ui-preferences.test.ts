import { describe, expect, it } from "vitest";
import { configAccentCases } from "./config-accent.test-support.js";
import { validateConfigObject } from "./validation.js";

describe("ui.seamColor", () => {
  it("accepts hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500" } });
    expect(res.ok).toBe(true);
  });

  it("rejects non-hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "lobster" } });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid hex length", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500FF" } });
    expect(res.ok).toBe(false);
  });
});

describe("ui.prefs.accent", () => {
  it.each(configAccentCases)("validates %s", (_label, accent, valid) => {
    expect(validateConfigObject({ ui: { prefs: { accent } } }).ok).toBe(valid);
  });
});

describe("ui.prefs.sidebarAgentOrder", () => {
  it("accepts ordered IDs and an explicit reset", () => {
    for (const sidebarAgentOrder of [["work", "main", "temporarily-missing"], []]) {
      expect(validateConfigObject({ ui: { prefs: { sidebarAgentOrder } } }).ok).toBe(true);
    }
  });
  it("rejects non-string IDs", () => {
    expect(validateConfigObject({ ui: { prefs: { sidebarAgentOrder: ["work", 7] } } }).ok).toBe(
      false,
    );
  });
});

describe("ui.prefs.sidebarEntries", () => {
  it("accepts the route and session entries synchronized by the Control UI", () => {
    const result = validateConfigObject({
      ui: {
        prefs: {
          sidebarEntries: ["route:usage", "session:agent:main:test"],
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects sidebar entries that are not strings", () => {
    const result = validateConfigObject({
      ui: {
        prefs: {
          sidebarEntries: ["route:usage", 7],
        },
      },
    });

    expect(result.ok).toBe(false);
  });
});
